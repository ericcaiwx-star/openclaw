import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { createChannelIngressQueue } from "../../../../src/channels/message/ingress-queue.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ALLOWED_SENDER = 1357;
const DENIED_SENDER = 2468;
const COMMAND_DENIED_SENDER = 3690;
const PLUGIN_ID = "telegram-raw-media-proof";
const PLUGIN_COMMAND = "raw_media_proof";
const FILE_CONTENT = "configured-root proof\n";

async function writeRawMediaPlugin(root: string, mediaFile: string, auditFile: string) {
  const pluginDir = path.join(root, "plugin");
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: PLUGIN_ID,
      version: "0.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      name: "Raw media proof",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const sdkUrl = (name: string) =>
    pathToFileURL(path.join(repoRoot, "dist/plugin-sdk", `${name}.js`)).href;
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      `import fs from "node:fs/promises";`,
      `import { definePluginEntry } from ${JSON.stringify(sdkUrl("plugin-entry"))};`,
      `import { getAgentScopedMediaLocalRoots } from ${JSON.stringify(sdkUrl("media-local-roots"))};`,
      `export default definePluginEntry({ id: ${JSON.stringify(PLUGIN_ID)}, name: "Raw media proof", register(api) {`,
      `api.registerCommand({ name: ${JSON.stringify(PLUGIN_COMMAND)}, description: "Return raw local attachment", channels: ["telegram"], handler: async (ctx) => {`,
      // Observe the child's real generic roots; do not pass them to delivery or grant trust.
      `const mediaUrl = ${JSON.stringify(mediaFile)};`,
      `await fs.appendFile(${JSON.stringify(auditFile)}, JSON.stringify({ senderId: ctx.senderId, mediaUrl, genericRoots: getAgentScopedMediaLocalRoots(ctx.config, ctx.agentId) }) + "\\n");`,
      `return { mediaUrl };`,
      `} }); } });`,
    ].join("\n"),
  );
  return pluginDir;
}

async function verifyTelegramMediaRoots(
  setting: "configured" | "absent" | "empty",
  source: "model" | "plugin" = "model",
) {
  const calls: Array<{ method: string; text?: string; fileBytes?: number }> = [];
  const uploadedBodies: string[] = [];
  const polls = new Set<ServerResponse>();
  const updates: unknown[] = [];
  const chat = { id: CHAT_ID, type: "supergroup", title: "QA Media Roots" };
  let updateId = 0;
  const succeed = (res: ServerResponse, result: unknown = true) =>
    writeJson(res, 200, { ok: true, result });
  const receive = (senderId: number, file: string, native: boolean) => {
    const update = {
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: { id: senderId, is_bot: false, first_name: "QA Sender" },
        text:
          source === "plugin"
            ? `/${PLUGIN_COMMAND}`
            : `${native ? "/new " : ""}Reply exactly: MEDIA:${file}`,
        ...(native
          ? {
              entities: [
                {
                  type: "bot_command",
                  offset: 0,
                  length: source === "plugin" ? PLUGIN_COMMAND.length + 1 : 4,
                },
              ],
            }
          : {}),
      },
    };
    const poll = polls.values().next().value;
    if (poll) {
      polls.delete(poll);
      succeed(poll, [update]);
    } else {
      updates.push(update);
    }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1)!;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    let text: string | undefined;
    let fileBytes: number | undefined;
    if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
      const form = await new Response(raw, {
        headers: { "content-type": req.headers["content-type"] },
      }).formData();
      for (const value of form.values()) {
        if (typeof value !== "string") {
          fileBytes = (fileBytes ?? 0) + value.size;
          uploadedBodies.push(await value.text());
        }
      }
    } else if (raw.length) {
      text = (JSON.parse(raw.toString()) as { text?: string }).text;
    }
    calls.push({ method, text, fileBytes });
    if (method === "getMe") {
      succeed(res, { id: 424242, is_bot: true, first_name: "QA", username: "qa_media_bot" });
    } else if (method === "getUpdates") {
      if (updates.length) {
        succeed(res, updates.splice(0));
      } else {
        polls.add(res);
        res.on("close", () => polls.delete(res));
      }
    } else if (method === "getChat") {
      succeed(res, chat);
    } else if (method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") {
      succeed(res, { message_id: 9000 + calls.length, date: 1_754_000_000, chat, text });
    } else {
      succeed(res);
    }
  };
  await withServer(
    (req, res) =>
      void handle(req, res).catch((error: unknown) => {
        writeJson(res, 500, { error: String(error) });
      }),
    async (apiRoot) =>
      await withTempDir("openclaw-configured-media-", async (root) => {
        const canonicalRoot = await fs.realpath(root);
        const workspace = path.join(canonicalRoot, "workspace");
        const mediaRoot = path.join(canonicalRoot, "trusted");
        await fs.mkdir(workspace);
        await fs.mkdir(mediaRoot);
        const mediaFile = path.join(
          source === "plugin" || setting === "configured" ? mediaRoot : workspace,
          "proof.txt",
        );
        await fs.writeFile(mediaFile, FILE_CONTENT);
        const auditFile = path.join(canonicalRoot, "plugin-invocations.jsonl");
        await fs.writeFile(auditFile, "");
        const pluginDir =
          source === "plugin"
            ? await writeRawMediaPlugin(canonicalRoot, mediaFile, auditFile)
            : undefined;
        const mock = await startQaMockOpenAiServer();
        const gatewayOwner = createQaGatewayChild();
        const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const outputDir = path.join(
          repoRoot,
          ".artifacts/qa-e2e/configured-media-roots",
          head,
          ...(source === "plugin" ? ["unstaged-native"] : []),
          setting,
        );
        const writeArtifact = async (name: string, value: unknown) => {
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(path.join(outputDir, name), JSON.stringify(value, null, 2));
        };
        try {
          const gateway = await gatewayOwner.start({
            repoRoot,
            providerMode: "mock-openai",
            providerBaseUrl: `${mock.baseUrl}/v1`,
            transportBaseUrl: apiRoot,
            transport: {
              requiredPluginIds: ["telegram"],
              createGatewayConfig: () => ({
                messages: { groupChat: { visibleReplies: "automatic" } },
                channels: {
                  telegram: {
                    enabled: true,
                    botToken: BOT_TOKEN,
                    apiRoot,
                    groupPolicy: "open",
                    streaming: { mode: "off" },
                    commands: { native: true },
                    groups: {
                      [String(CHAT_ID)]: {
                        requireMention: false,
                        toolsBySender: { [`id:${DENIED_SENDER}`]: { deny: ["read"] } },
                      },
                    },
                  },
                },
              }),
            },
            controlUiEnabled: false,
            runtimeEnvPatch: {
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              TELEGRAM_BOT_TOKEN: undefined,
            },
            mutateConfig: (cfg) => {
              cfg.agents!.defaults!.workspace = workspace;
              if (setting !== "absent") {
                cfg.agents!.defaults!.mediaLocalRoots = setting === "empty" ? [] : [mediaRoot];
              }
              cfg.tools = { ...cfg.tools, profile: "full" };
              // Transport config projects only channels/messages. Root command
              // authorization belongs here; disable text fallback for native proof.
              cfg.commands = {
                native: true,
                text: false,
                allowFrom: { telegram: [String(ALLOWED_SENDER), String(DENIED_SENDER)] },
              };
              cfg.bindings = [{ agentId: "qa", match: { channel: "telegram" } }];
              if (pluginDir) {
                cfg.plugins = {
                  ...cfg.plugins,
                  allow: [...new Set([...(cfg.plugins?.allow ?? []), PLUGIN_ID])],
                  entries: { ...cfg.plugins?.entries, [PLUGIN_ID]: { enabled: true } },
                  load: {
                    ...cfg.plugins?.load,
                    paths: [...(cfg.plugins?.load?.paths ?? []), pluginDir],
                  },
                };
              }
              return cfg;
            },
          });
          expect(new URL(gateway.baseUrl).port).not.toBe("18789");
          expect(gateway.cfg.commands).toMatchObject({
            text: false,
            allowFrom: { telegram: [String(ALLOWED_SENDER), String(DENIED_SENDER)] },
          });
          await expect.poll(() => polls.size, { timeout: 30_000 }).toBeGreaterThan(0);
          const readRequestCount = async () =>
            ((await (await fetch(`${mock.baseUrl}/debug/requests`)).json()) as unknown[]).length;
          if (source === "plugin") {
            const readInvocations = async () =>
              (await fs.readFile(auditFile, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map(
                  (line) =>
                    JSON.parse(line) as {
                      senderId: string;
                      mediaUrl: string;
                      genericRoots: string[];
                    },
                );
            const effects = [];
            const ingress = createChannelIngressQueue({
              channelId: "telegram",
              accountId: "default",
              stateDir: path.join(gateway.tempRoot, "state"),
              access: "read-only",
            });
            // Default requireAuth is retained; this sender must not enter the plugin handler.
            receive(COMMAND_DENIED_SENDER, mediaFile, true);
            await expect
              .poll(
                () =>
                  calls.some((call) => call.text === "You are not authorized to use this command."),
                { timeout: 30_000 },
              )
              .toBe(true);
            expect(await readInvocations()).toEqual([]);
            expect(uploadedBodies).toEqual([]);
            for (const senderId of setting === "configured"
              ? [ALLOWED_SENDER, DENIED_SENDER]
              : [ALLOWED_SENDER]) {
              const start = calls.length;
              const logMark = gateway.markLogs();
              const denied = setting !== "configured" || senderId === DENIED_SENDER;
              receive(senderId, mediaFile, true);
              await expect
                .poll(async () => (await readInvocations()).length, { timeout: 30_000 })
                .toBeGreaterThanOrEqual(effects.length + 1);
              const invocation = (await readInvocations()).at(-1)!;
              expect(invocation.senderId).toBe(String(senderId));
              expect(invocation.mediaUrl).toBe(mediaFile);
              expect(invocation.genericRoots.length).toBeGreaterThan(0);
              expect(
                invocation.genericRoots.every((genericRoot) => {
                  const relative = path.relative(genericRoot, mediaFile);
                  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
                }),
              ).toBe(true);
              let denial;
              if (denied) {
                // Native plugin load failures remain retryable in the existing ingress owner.
                // Observe its committed error, not silence or a fabricated terminal message.
                const readFailure = async () =>
                  (await ingress.listPending({ limit: "all" })).find(
                    (entry) =>
                      entry.id === String(updateId).padStart(16, "0") &&
                      entry.attempts > 0 &&
                      entry.lastError?.includes("LocalMediaAccessError") &&
                      entry.lastError.includes(
                        "Local media path is not under an allowed directory",
                      ) &&
                      entry.lastError.includes(mediaFile),
                  );
                await expect.poll(readFailure, { timeout: 30_000 }).toBeDefined();
                const entry = (await readFailure())!;
                await expect
                  .poll(() => gateway.readLogsSince(logMark), { timeout: 10_000 })
                  .toContain("keeping for retry");
                denial = {
                  disposition: "pending-retry",
                  eventId: entry.id,
                  attempts: entry.attempts,
                  error: entry.lastError,
                };
                expect(calls.slice(start).filter((call) => call.fileBytes)).toEqual([]);
              } else {
                await expect
                  .poll(() => uploadedBodies, { timeout: 30_000 })
                  .toEqual([FILE_CONTENT]);
              }
              effects.push({
                senderId,
                denied,
                denial,
                returnedMediaPath: invocation.mediaUrl,
                uploads: calls.slice(start).filter((call) => call.fileBytes),
                messages: calls.slice(start).filter((call) => call.method === "sendMessage"),
              });
            }
            expect(await readRequestCount()).toBe(0);
            const verdict = {
              head,
              lane: "mock-gateway",
              source: "unstaged-native-plugin",
              setting,
              passed: true,
              effects,
              handlerInvocations: await readInvocations(),
              uploadedBodies,
              providerRequests: 0,
              unauthorizedHandlerInvocations: 0,
              liveTelegram: false,
            };
            await writeArtifact("verdict.json", verdict);
            return;
          }
          const effects = [];
          for (const native of [false, true]) {
            for (const senderId of [ALLOWED_SENDER, DENIED_SENDER]) {
              const start = calls.length;
              // Model MEDIA staging already enforces sender read policy before
              // Telegram delivery, independently of configured delivery roots.
              const denied = senderId === DENIED_SENDER;
              receive(senderId, mediaFile, native);
              if (denied) {
                await expect
                  .poll(
                    () =>
                      calls
                        .slice(start)
                        .some(
                          (call) =>
                            call.method === "sendMessage" && call.text?.includes("Delivery failed"),
                        ),
                    { timeout: 45_000 },
                  )
                  .toBe(true);
                expect(calls.slice(start).filter((call) => call.fileBytes)).toEqual([]);
              } else {
                await expect
                  .poll(() => calls.slice(start).filter((call) => call.fileBytes), {
                    timeout: 45_000,
                  })
                  .toEqual([{ method: "sendDocument", text: undefined, fileBytes: 22 }]);
              }
              effects.push({
                route: native ? "native-new" : "direct",
                senderId,
                denied,
                uploads: calls.slice(start).filter((call) => call.fileBytes),
                messages: calls.slice(start).filter((call) => call.method === "sendMessage"),
              });
            }
          }
          // Non-ACP durable /new retains sessionId (session.ts); ID rotation is
          // not a native-command oracle. Instead prove the native-only auth gate:
          // the same sender/prompt is admitted as text but rejected as /new.
          const ordinaryStart = calls.length;
          receive(COMMAND_DENIED_SENDER, mediaFile, false);
          await expect
            .poll(() => calls.slice(ordinaryStart).filter((call) => call.fileBytes), {
              timeout: 45_000,
            })
            .toEqual([{ method: "sendDocument", text: undefined, fileBytes: 22 }]);
          const ordinaryUploads = calls.slice(ordinaryStart).filter((call) => call.fileBytes);
          const nativeStart = calls.length;
          const requestsBeforeNativeDenial = await readRequestCount();
          receive(COMMAND_DENIED_SENDER, mediaFile, true);
          await expect
            .poll(
              () =>
                calls
                  .slice(nativeStart)
                  .some(
                    (call) =>
                      call.method === "sendMessage" &&
                      call.text === "You are not authorized to use this command.",
                  ),
              { timeout: 45_000 },
            )
            .toBe(true);
          expect(calls.slice(nativeStart).filter((call) => call.fileBytes)).toEqual([]);
          const providerRequests = await readRequestCount();
          expect(providerRequests).toBe(requestsBeforeNativeDenial);
          expect(providerRequests).toBeGreaterThanOrEqual(5);
          const verdict = {
            head,
            lane: "mock-gateway",
            passed: true,
            setting,
            providerRequests,
            effects,
            nativeAdmission: {
              senderId: COMMAND_DENIED_SENDER,
              ordinaryUploads,
              nativeMessages: calls
                .slice(nativeStart)
                .filter((call) => call.method === "sendMessage"),
              requestsBeforeNativeDenial,
              requestsAfterNativeDenial: providerRequests,
            },
            liveTelegram: false,
          };
          await writeArtifact("verdict.json", verdict);
        } catch (error) {
          await writeArtifact("failure-observations.json", {
            setting,
            source,
            calls,
            uploadedBodies,
            pluginInvocations: await fs.readFile(auditFile, "utf8"),
            providerRequests: (
              (await (await fetch(`${mock.baseUrl}/debug/requests`)).json()) as unknown[]
            ).length,
          });
          throw error;
        } finally {
          try {
            await stopQaGatewayFixture(gatewayOwner, {
              preserveToDir: path.join(outputDir, "gateway"),
            });
          } finally {
            try {
              await mock.stop();
            } finally {
              for (const poll of polls) {
                poll.destroy();
              }
            }
          }
        }
      }),
  );
}

test.each(["configured", "absent", "empty"] as const)(
  "Telegram media roots: %s",
  (setting) => verifyTelegramMediaRoots(setting),
  180_000,
);

test.each(["configured", "absent", "empty"] as const)(
  "Telegram unstaged native media roots: %s",
  (setting) => verifyTelegramMediaRoots(setting, "plugin"),
  180_000,
);
