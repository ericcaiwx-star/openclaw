import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  expectOpenAITransportRequestPolicy,
} from "../../../../test/helpers/openai-transport-request-policy.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessage, SimpleStreamOptions } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

describe("openai completions transport requests", () => {
  it("replays unavailable historical tools as text without breaking declared call/result ordering", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let input = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        input += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(input);
        requests.push(body);
        const declared = new Set(
          body.tools.map((tool: { function: { name: string } }) => tool.function.name),
        );
        let pending = new Set<string>();
        let valid = true;
        for (const message of body.messages) {
          if (message.role === "tool") {
            valid &&= pending.delete(message.tool_call_id);
          } else {
            valid &&= pending.size === 0;
            pending = new Set((message.tool_calls ?? []).map((call: { id: string }) => call.id));
            valid &&= (message.tool_calls ?? []).every((call: { function: { name: string } }) =>
              declared.has(call.function.name),
            );
          }
        }
        valid &&= pending.size === 0;
        if (!valid) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Undeclared function or unpaired result" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({
            id: "history-replay",
            object: "chat.completion.chunk",
            created: 1,
            model: "strict-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "accepted" },
                finish_reason: "stop",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "strict-model",
        provider: "custom",
        reasoning: false,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      // Unknown calls and ordinary completed tools removed from the catalog share this boundary.
      for (const names of [["session_status"], ["wait"], ["read", "session_status", "read"]]) {
        const context = {
          tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
          messages: [
            {
              role: "assistant" as const,
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: names.map((name, i) => ({
                type: "toolCall" as const,
                id: `call_${i}`,
                name,
                arguments: {},
              })),
              usage: createZeroUsage(),
              stopReason: "toolUse" as const,
              timestamp: 1,
            },
            ...names.map((name, i) => ({
              role: "toolResult" as const,
              toolCallId: `call_${i}`,
              // Ownership must follow the paired call, not a stale toolName on its result.
              toolName: "stale_metadata",
              content: [{ type: "text" as const, text: `recorded result ${i}` }],
              isError: name === "session_status",
              timestamp: 2,
            })),
            { role: "user" as const, content: "Continue", timestamp: 3 },
          ],
        };
        const original = structuredClone(context);
        for (let turn = 0; turn < 2; turn += 1) {
          const stream = await createOpenAICompletionsTransportStreamFn()(model, context, {
            apiKey: "synthetic",
          });
          const result = await stream.result();
          expect(result.stopReason).toBe("stop");
          expect(result.content).toEqual([{ type: "text", text: "accepted" }]);
        }
        expect(context).toEqual(original);
        const serialized = JSON.stringify(requests.at(-1));
        expect(serialized).toContain(names.includes("session_status") ? "session_status" : "wait");
        const native = (
          (requests.at(-1)?.messages ?? []) as Array<{ tool_calls?: unknown[] }>
        ).flatMap((message) => message.tool_calls ?? []);
        expect(native).toHaveLength(names.filter((name) => name === "read").length);
        expect(serialized).toContain("recorded result");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    {
      api: "openai-completions" as const,
      provider: "openai",
      createStream: createOpenAICompletionsTransportStreamFn,
    },
  ])(
    "honors turn timeout and pinned SDK retries over real $api HTTP",
    expectOpenAITransportRequestPolicy,
    COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  );
  it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_error_metadata",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "Quota exceeded for api_key=sk-secret1234567890abcd",
              type: "rate_limit_error",
              code: "insufficient_quota",
            },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let errorPayload: Record<string, unknown> | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "error") {
          errorPayload = event.error;
        }
      }

      expect(errorPayload).toMatchObject({
        stopReason: "error",
        errorCode: "insufficient_quota",
        errorType: "rate_limit_error",
      });
      expect(String(errorPayload?.errorBody)).toContain("Quota exceeded");
      expect(String(errorPayload?.errorBody)).not.toContain("sk-secret1234567890abcd");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["managed", "direct"] as const)(
    "preserves JSON completions and honors streaming controls (%s)",
    async (mode) => {
      const capturedRequests: Array<Record<string, unknown>> = [];
      let includeTools = false;
      let oversized = false;
      let releaseBody: (() => void) | undefined;
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          const responseBody = oversized
            ? " ".repeat(16 * 1024 * 1024 + 1)
            : JSON.stringify({
                id: "chatcmpl-json-fallback",
                object: "chat.completion",
                model: "moonshotai/kimi-k2.6",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      reasoning_content: "Need a direct answer.",
                      content: "live-ok",
                      ...(includeTools
                        ? {
                            tool_calls: [
                              {
                                id: "call_weather",
                                type: "function",
                                function: { name: "weather", arguments: '{"city":"Vienna"}' },
                              },
                              {
                                id: "call_time",
                                type: "function",
                                function: { name: "time", arguments: '{"zone":"UTC"}' },
                              },
                            ],
                          }
                        : {}),
                    },
                    finish_reason: includeTools ? "tool_calls" : "stop",
                  },
                ],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
              });
          if (capturedRequests.at(-1)?.stream === false) {
            releaseBody = () => res.end(responseBody);
            res.flushHeaders();
          } else {
            releaseBody = undefined;
            res.end(responseBody);
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }
        const model = makeCompletionsModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi K2.6",
          provider: "openrouter",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          contextWindow: 256_000,
          maxTokens: 16_384,
          compat: {
            supportsReasoningEffort: true,
          },
        });
        const createStream =
          mode === "managed"
            ? createOpenAICompletionsTransportStreamFn()
            : streamSimpleOpenAICompletions;
        for (const scenario of [
          { params: {}, options: {}, expected: true, tools: false },
          { params: { streaming: false }, options: {}, expected: false, tools: false },
          { params: {}, options: { streaming: false }, expected: false, tools: true },
          {
            params: { streaming: false },
            options: { streaming: true },
            expected: true,
            tools: true,
          },
        ]) {
          includeTools = scenario.tools;
          const options: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "streaming"> = {
            apiKey: "test-key",
            reasoning: "high",
            ...scenario.options,
            onResponse: () => {
              releaseBody?.();
            },
          };
          const stream = await createStream(
            { ...model, params: scenario.params },
            {
              systemPrompt: "system",
              messages: [{ role: "user", content: "Reply live-ok", timestamp: 1 }],
              tools: [],
            },
            options,
          );
          let final: AssistantMessage | undefined;
          const eventTypes: string[] = [];
          for await (const event of stream) {
            eventTypes.push(event.type);
            if (event.type === "done") {
              final = event.message;
            }
          }
          const request = capturedRequests.at(-1);
          expect(request?.stream).toBe(scenario.expected);
          if (scenario.expected) {
            expect(request?.stream_options).toEqual({ include_usage: true });
          } else {
            expect(request).not.toHaveProperty("stream_options");
          }
          expect(eventTypes).toContain("text_delta");
          expect(eventTypes).toContain("thinking_delta");
          expect(eventTypes[0]).toBe("start");
          expect(eventTypes.at(-1)).toBe("done");
          expect(final).toMatchObject({
            responseId: "chatcmpl-json-fallback",
            stopReason: includeTools ? "toolUse" : "stop",
            usage: { input: 2, output: 3, totalTokens: 5 },
          });
          expect(final?.content).toEqual([
            expect.objectContaining({
              type: "thinking",
              thinking: "Need a direct answer.",
              thinkingSignature: "reasoning_content",
            }),
            expect.objectContaining({ type: "text", text: "live-ok" }),
            ...(includeTools
              ? [
                  expect.objectContaining({
                    type: "toolCall",
                    id: "call_weather",
                    name: "weather",
                    arguments: { city: "Vienna" },
                  }),
                  expect.objectContaining({
                    type: "toolCall",
                    id: "call_time",
                    name: "time",
                    arguments: { zone: "UTC" },
                  }),
                ]
              : []),
          ]);
          expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(
            includeTools ? 2 : 0,
          );
        }
        oversized = true;
        const options: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "streaming"> = {
          apiKey: "test-key",
          streaming: false,
          onResponse: () => {
            releaseBody?.();
          },
        };
        const oversizedStream = await createStream(
          model,
          {
            messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
          },
          options,
        );
        expect(await oversizedStream.result()).toMatchObject({
          stopReason: "error",
          errorMessage: expect.stringContaining("JSON response exceeds 16777216 bytes"),
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
