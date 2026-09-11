import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const ISOLATED_GATEWAY_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

let sequence = 0;

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

beforeEach(resetGatewayState);
afterEach(resetGatewayState);

it(
  "compacts a literal global session in an explicit fleet when agentId is supplied",
  { timeout: 90_000 },
  async () => {
    const envSnapshot = captureEnv([...ISOLATED_GATEWAY_ENV_KEYS]);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-compact-global-owner-"));
    const workspaceDir = path.join(tempHome, "openclaw");
    const bundledPluginsDir = path.join(tempHome, "openclaw-test-empty-bundled-plugins");
    const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(bundledPluginsDir, { recursive: true }),
      fs.mkdir(path.dirname(configPath), { recursive: true }),
    ]);
    const token = nextId("compact-global-owner-token");
    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: path.join(tempHome, ".openclaw"),
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");

    const summary = "GLOBAL_OWNER_COMPACTION_SUMMARY";
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const message = {
          type: "message",
          id: nextId("provider-message"),
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: summary, annotations: [] }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          {
            type: "response.output_item.added",
            item: { ...message, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", item: message },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const providerAddress = providerServer.address();
      if (!providerAddress || typeof providerAddress === "string") {
        throw new Error("mock OpenAI Responses server did not bind a loopback port");
      }
      const baseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
      const primaryModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-primary");
      const compactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-global-summary");
      const availableModels = [primaryModel, compactionModel];
      const modelDefaults = { params: { transport: "sse", openaiWsWarmup: false } };

      const config = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            model: { primary: primaryModel.modelRef },
            models: Object.fromEntries(
              availableModels.map(({ modelRef }) => [modelRef, modelDefaults]),
            ),
            compaction: {
              model: compactionModel.modelRef,
              keepRecentTokens: 1,
              recentTurnsPreserve: 1,
              qualityGuard: { enabled: false },
              memoryFlush: { enabled: false },
            },
          },
          entries: { main: {}, work: {} },
        },
        models: {
          mode: "replace",
          providers: {
            [primaryModel.providerId]: {
              ...primaryModel.config,
              models: Array.from(availableModels, ({ config: modelConfig }) => ({
                ...modelConfig.models[0],
                input: Array.from(modelConfig.models[0].input),
              })),
            },
          },
        },
        gateway: { auth: { mode: "token", token } },
      } satisfies OpenClawConfig;

      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token,
        clientDisplayName: "vitest-compact-global-owner",
      });
      const sessionKey = "global";
      const sessionId = nextId("global-owner-session");
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
        compactionCount: 0,
        modelProvider: primaryModel.providerId,
        model: primaryModel.modelId,
        totalTokens: 20,
        totalTokensFresh: true,
      });
      const persistedContext = "persisted conversation ".repeat(24);
      for (let turn = 0; turn < 6; turn += 1) {
        const timestamp = Date.now() + turn;
        await appendTranscriptMessage(scope, {
          message: {
            role: "user",
            content: `Historical request ${turn}: ${persistedContext}`,
            timestamp,
          },
        });
        await appendTranscriptMessage(scope, {
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Historical answer ${turn}: ${persistedContext}` }],
            api: "openai-responses",
            provider: primaryModel.providerId,
            model: primaryModel.modelId,
            usage: {
              input: 10,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 20,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp,
          },
        });
      }

      const compacted = await gateway.client.request<{
        ok?: boolean;
        compacted?: boolean;
        reason?: string;
      }>("sessions.compact", { key: "global", agentId: "main" }, { timeoutMs: 35_000 });

      expect(compacted.reason ?? "").not.toMatch(/no explicit owner/);
      expect(compacted).toMatchObject({ ok: true, compacted: true });
      expect(loadTranscriptEventsSync(scope)).toContainEqual(
        expect.objectContaining({
          type: "compaction",
          summary: expect.stringContaining(summary),
        }),
      );
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "global-owner compaction e2e complete" });
      }
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      envSnapshot.restore();
    }
  },
);
