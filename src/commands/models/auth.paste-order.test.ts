/**
 * Owner-boundary proof that paste with an existing global auth.order does not
 * persist a per-agent stored override. Stored order wins over config, so a
 * paste-created copy would freeze that agent against later auth.order edits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  resolveExplicitAuthOrderSelection,
} from "../../agents/auth-profiles/order.js";
import {
  setAuthProfileOrder,
  upsertAuthProfileWithLockOrThrow,
} from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreForRuntime } from "../../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const { modelsAuthPasteApiKeyCommand, modelsAuthPasteTokenCommand } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withPipedStdin(input: string) {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const previousAsyncIteratorDescriptor = Object.getOwnPropertyDescriptor(
    stdin,
    Symbol.asyncIterator,
  );
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => false,
  });
  Object.defineProperty(stdin, Symbol.asyncIterator, {
    configurable: true,
    async *value() {
      yield input;
    },
  });
  return () => {
    if (previousAsyncIteratorDescriptor) {
      Object.defineProperty(stdin, Symbol.asyncIterator, previousAsyncIteratorDescriptor);
    } else {
      Reflect.deleteProperty(stdin, Symbol.asyncIterator);
    }
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

describe("paste auth order ownership", () => {
  let restoreStdin: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockResolvedValue({});
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => mutator({}),
    );
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    {
      label: "paste-api-key",
      secret: "sk-openai-chatgpt-api-key-value",
      run: (runtime: RuntimeEnv) =>
        modelsAuthPasteApiKeyCommand({ provider: "openai", agent: "coder" }, runtime),
    },
    {
      label: "paste-token",
      secret: "openai-token",
      run: (runtime: RuntimeEnv) =>
        modelsAuthPasteTokenCommand({ provider: "openai", agent: "coder" }, runtime),
    },
  ])(
    "$label with existing auth.order leaves later global-order edits in charge",
    async ({ secret, run }) => {
      const stateDir = await fs.promises.realpath(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-paste-order-")),
      );
      const coderAgentDir = path.join(stateDir, "agents", "coder", "agent");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      fs.mkdirSync(coderAgentDir, { recursive: true });
      fs.mkdirSync(mainAgentDir, { recursive: true });

      const initialOrder = ["openai:old-login"];
      const laterOrder = ["openai:new-first", "openai:old-login"];
      const config: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "coder" }],
        },
        auth: {
          order: {
            openai: initialOrder,
          },
        },
      };
      mocks.loadValidConfigOrThrow.mockImplementation(async () => config);
      restoreStdin = withPipedStdin(`${secret}\n`);

      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, HOME: stateDir }, async () => {
          const runtime = createRuntime();
          await run(runtime);
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining("saved but excluded by the configured auth selection"),
          );
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(
              "openclaw models auth order set --provider openai --agent coder openai:manual",
            ),
          );

          const store = loadAuthProfileStoreForRuntime(coderAgentDir);
          expect(store.profiles["openai:manual"]).toBeDefined();
          expect(store.order?.openai).toBeUndefined();
          expect(
            loadAuthProfileStoreForRuntime(mainAgentDir).profiles["openai:manual"],
          ).toBeUndefined();
          expect(mocks.updateConfig).not.toHaveBeenCalled();

          expect(
            resolveExplicitAuthOrderSelection({
              storeOrder: store.order,
              configuredOrder: config.auth?.order,
              providerKey: "openai",
              providerAuthKey: "openai",
            }),
          ).toEqual({ order: initialOrder, fromStore: false });

          expect(
            resolveExplicitAuthOrderSelection({
              storeOrder: store.order,
              configuredOrder: { openai: laterOrder },
              providerKey: "openai",
              providerAuthKey: "openai",
            }),
          ).toEqual({ order: laterOrder, fromStore: false });
        });
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps main-agent pastes in the shared owner inherited by secondary agents", async () => {
    const stateDir = await fs.promises.realpath(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-paste-shared-")),
    );
    mocks.loadValidConfigOrThrow.mockResolvedValue({
      agents: { list: [{ id: "main" }, { id: "coder" }] },
    });
    restoreStdin = withPipedStdin("shared-main-fixture\n");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, HOME: stateDir }, async () => {
        const runtime = createRuntime();
        await modelsAuthPasteApiKeyCommand({ provider: "deepseek", agent: "main" }, runtime);
        const inherited = loadAuthProfileStoreForRuntime(
          path.join(stateDir, "agents", "coder", "agent"),
        );
        expect(inherited.profiles["deepseek:manual"]).toEqual({
          type: "api_key",
          provider: "deepseek",
          key: "shared-main-fixture",
        });
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("excluded"));
        expect(mocks.updateConfig).not.toHaveBeenCalled();
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["paste-api-key", "paste-token"])(
    "%s preserves incompatible declared credentials and recovers a distinct profile",
    async (command) => {
      const stateDir = await fs.promises.realpath(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-paste-compat-")),
      );
      const agentDir = path.join(stateDir, "agents", "coder", "agent");
      const profileId = "deepseek:manual";
      const distinctId = "deepseek:new";
      const credential =
        command === "paste-api-key"
          ? { type: "token" as const, provider: "deepseek", token: "existing-token" }
          : { type: "api_key" as const, provider: "deepseek", key: "existing-key" };
      const config: OpenClawConfig = {
        agents: { list: [{ id: "main" }, { id: "coder" }] },
        auth: { profiles: { [profileId]: { provider: "deepseek", mode: credential.type } } },
      };
      mocks.loadValidConfigOrThrow.mockResolvedValue(config);
      const run =
        command === "paste-api-key" ? modelsAuthPasteApiKeyCommand : modelsAuthPasteTokenCommand;
      restoreStdin = withPipedStdin("new-pasted-credential\n");
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, HOME: stateDir }, async () => {
          await upsertAuthProfileWithLockOrThrow({ agentDir, profileId, credential });
          const runtime = createRuntime();
          await expect(run({ provider: "deepseek", agent: "coder" }, runtime)).rejects.toThrow(
            "--profile-id",
          );
          const preserved = loadAuthProfileStoreForRuntime(agentDir);
          expect(preserved.profiles[profileId]).toEqual(credential);
          expect(
            resolveAuthProfileEligibility({
              cfg: config,
              store: preserved,
              provider: "deepseek",
              profileId,
            }).eligible,
          ).toBe(true);
          expect(mocks.callGateway).not.toHaveBeenCalled();

          await run({ provider: "deepseek", agent: "coder", profileId: distinctId }, runtime);
          const saved = loadAuthProfileStoreForRuntime(agentDir);
          expect(saved.profiles[profileId]).toEqual(credential);
          expect(saved.profiles[distinctId]).toBeDefined();
          expect(saved.order?.deepseek).toBeUndefined();
          expect(
            resolveAuthProfileOrder({ cfg: config, store: saved, provider: "deepseek" }),
          ).toEqual([profileId]);
          expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("saved but excluded"));
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(
              "openclaw models auth order set --provider deepseek --agent coder deepseek:new",
            ),
          );

          await setAuthProfileOrder({
            agentDir,
            provider: "deepseek",
            order: [distinctId, profileId],
          });
          expect(
            resolveAuthProfileOrder({
              cfg: config,
              store: loadAuthProfileStoreForRuntime(agentDir),
              provider: "deepseek",
            }),
          ).toEqual([distinctId, profileId]);
          expect(mocks.updateConfig).not.toHaveBeenCalled();
        });
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
