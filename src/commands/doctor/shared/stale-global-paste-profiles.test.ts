// Doctor leftover-global-paste tests cover report-only diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePersistedAuthProfileStoreRaw } from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { collectStaleGlobalPasteFindings } from "./stale-global-paste-profiles.js";

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

describe("collectStaleGlobalPasteFindings", () => {
  it("warns when a global declaration is only resolvable on a secondary agent", async () => {
    await withStateDir("openclaw-stale-paste-findings-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([
        {
          checkId: "core/doctor/auth-stale-global-paste",
          severity: "warning",
          message:
            "auth.profiles.openrouter:default is declared globally, but only agent ops has a usable api_key; the default agent cannot resolve it.",
          target: PROFILE_ID,
          fixHint:
            "Leave the declaration if it is intentional. To give the default agent this profile, paste the credential into that agent. Doctor --fix will not delete global auth.profiles or auth.order from this warning.",
        },
      ]);
    });
  });

  it("warns for token metadata without offering a mutating repair", async () => {
    await withStateDir("openclaw-stale-paste-token-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", tokenStore("tok-ops-only"));
      const cfg = leftoverConfig({ mode: "token" });

      const findings = collectStaleGlobalPasteFindings({ cfg, env });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("usable token");
      expect(findings[0]?.fixHint).toContain("Doctor --fix will not delete");
      expect(cfg.auth?.profiles?.[PROFILE_ID]).toEqual({
        provider: "openrouter",
        mode: "token",
      });
      expect(cfg.auth?.order?.openrouter).toEqual([PROFILE_ID]);
    });
  });

  it("keeps an intentional global order when only a secondary agent has the secret", async () => {
    await withStateDir("openclaw-stale-paste-intentional-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));
      const cfg = leftoverConfig();
      const before = structuredClone(cfg);

      collectStaleGlobalPasteFindings({ cfg, env });

      expect(cfg).toEqual(before);
      expect(cfg.auth?.order?.openrouter).toEqual([PROFILE_ID]);
      expect(cfg.auth?.profiles?.[PROFILE_ID]).toEqual({
        provider: "openrouter",
        mode: "api_key",
      });
    });
  });

  it("does not warn for oauth or aws-sdk declarations", async () => {
    await withStateDir("openclaw-stale-paste-oauth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops-only"));

      for (const mode of ["oauth", "aws-sdk"] as const) {
        expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig({ mode }), env })).toEqual([]);
      }
    });
  });

  it("does not warn when the default agent already has the secret", async () => {
    await withStateDir("openclaw-stale-paste-default-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "main", apiKeyStore("sk-main"));
      await writeAgentStore(stateDir, "ops", apiKeyStore("sk-ops"));

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([]);
    });
  });

  it("does not warn when a secondary secret uses a different provider", async () => {
    await withStateDir("openclaw-stale-paste-provider-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", {
        version: 1,
        profiles: {
          [PROFILE_ID]: { type: "api_key", provider: "anthropic", key: "sk-anthropic-ops" },
        },
      });

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([]);
    });
  });

  it("does not warn when a secondary secret uses an incompatible mode", async () => {
    await withStateDir("openclaw-stale-paste-mode-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", tokenStore("tok-ops-only"));

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([]);
    });
  });

  it("does not warn when no agent store has a usable secret", async () => {
    await withStateDir("openclaw-stale-paste-empty-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeAgentStore(stateDir, "ops", {
        version: 1,
        profiles: {
          [PROFILE_ID]: { type: "api_key", provider: "openrouter" },
        },
      });

      expect(collectStaleGlobalPasteFindings({ cfg: leftoverConfig(), env })).toEqual([]);
    });
  });
});
