// Doctor leftover-global-paste tests cover conservative auth.profiles cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePersistedAuthProfileStoreRaw } from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  collectStaleGlobalPasteFindings,
  maybeRepairStaleGlobalPasteProfiles,
} from "./stale-global-paste-profiles.js";

const PROFILE_ID = "openrouter:default";

function leftoverConfig(params?: {
  mode?: "api_key" | "token" | "oauth" | "aws-sdk";
}): OpenClawConfig {
  const mode = params?.mode ?? "api_key";
  return {
    agents: {
      list: [{ id: "main", default: true }, { id: "ops" }],
    },
    auth: {
      profiles: {
        [PROFILE_ID]: { provider: "openrouter", mode },
      },
      order: { openrouter: [PROFILE_ID] },
    },
  };
}

function apiKeyStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PROFILE_ID]: { type: "api_key", provider: "openrouter", key },
    },
  };
}

function tokenStore(token: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PROFILE_ID]: { type: "token", provider: "openrouter", token },
    },
  };
}

async function withStateDir<T>(prefix: string, run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(stateDir);
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function agentDir(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent");
}

async function writeAgentStore(
  stateDir: string,
  agentId: string,
  store: AuthProfileStore,
): Promise<void> {
  const dir = agentDir(stateDir, agentId);
  await fs.mkdir(dir, { recursive: true });
  writePersistedAuthProfileStoreRaw(store, dir);
}

describe("maybeRepairStaleGlobalPasteProfiles", () => {
  it("removes leftover api_key metadata when the secret lives only on a secondary agent", async () => {
    await withStateDir("openclaw-stale-paste-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));
      const cfg = leftoverConfig();

      const result = maybeRepairStaleGlobalPasteProfiles({ cfg, env });

      expect(result.config.auth).toBeUndefined();
      expect(result.changes).toEqual([
        "auth.profiles.openrouter:default: removed leftover api_key metadata (credential lives only on agent ops).",
      ]);
    });
  });

  it("removes leftover token metadata and strips that id from auth.order", async () => {
    await withStateDir("openclaw-stale-paste-token-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", tokenStore("tok-ops-only"));
      const cfg = leftoverConfig({ mode: "token" });
      cfg.auth = {
        ...cfg.auth,
        order: { openrouter: [PROFILE_ID, "openrouter:keep"] },
        profiles: {
          ...cfg.auth?.profiles,
          "openrouter:keep": { provider: "openrouter", mode: "oauth" },
        },
      };

      const result = maybeRepairStaleGlobalPasteProfiles({ cfg, env });

      expect(result.config.auth).toEqual({
        profiles: { "openrouter:keep": { provider: "openrouter", mode: "oauth" } },
        order: { openrouter: ["openrouter:keep"] },
      });
      expect(result.changes).toHaveLength(1);
    });
  });

  it("keeps oauth and aws-sdk declarations even when a secondary agent has a paste secret", async () => {
    await withStateDir("openclaw-stale-paste-oauth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));

      for (const mode of ["oauth", "aws-sdk"] as const) {
        const cfg = leftoverConfig({ mode });
        const result = maybeRepairStaleGlobalPasteProfiles({ cfg, env });
        expect(result).toEqual({ config: cfg, changes: [] });
      }
    });
  });

  it("keeps the declaration when the default agent already has the secret", async () => {
    await withStateDir("openclaw-stale-paste-default-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "main", apiKeyStore("sk-main"));
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops"));
      const cfg = leftoverConfig();

      const result = maybeRepairStaleGlobalPasteProfiles({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    });
  });

  it("keeps the declaration when no agent store has a usable secret", async () => {
    await withStateDir("openclaw-stale-paste-empty-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", {
        version: 1,
        profiles: {
          [PROFILE_ID]: { type: "api_key", provider: "openrouter" },
        },
      });
      const cfg = leftoverConfig();

      const result = maybeRepairStaleGlobalPasteProfiles({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    });
  });
});

describe("collectStaleGlobalPasteFindings", () => {
  it("emits a warning with a doctor --fix hint for leftover secondary-agent paste metadata", async () => {
    await withStateDir("openclaw-stale-paste-findings-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([
        {
          checkId: "core/doctor/auth-stale-global-paste",
          severity: "warning",
          message:
            "auth.profiles.openrouter:default is leftover secondary-agent api_key metadata; the default agent cannot resolve it.",
          target: PROFILE_ID,
          fixHint:
            "Run `openclaw doctor --fix` to drop this global declaration. The credential stays in agent ops.",
        },
      ]);
    });
  });
});
