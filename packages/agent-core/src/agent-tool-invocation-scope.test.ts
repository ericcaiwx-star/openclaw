import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  config,
  makeAssistantMessage,
  makeCall,
  makeTool,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { type AssistantMessage, createAssistantMessageEventStream } from "./llm.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";

function createResponse(responseId?: string): AssistantMessage {
  return {
    ...makeAssistantMessage([makeCall("crabbox", "crabbox_0")]),
    ...(responseId ? { responseId } : {}),
  };
}

async function runResponse(message: AssistantMessage) {
  const committed: AssistantMessage[] = [];
  const executedScopes: Array<AssistantMessage["toolInvocationScope"]> = [];
  const executedCallIds: string[] = [];
  const execute = vi.fn(async (toolCallId: string) => {
    const owner = getAgentToolExecutionContext()?.assistantMessage;
    expect(committed).toContain(owner);
    executedCallIds.push(toolCallId);
    executedScopes.push(owner?.toolInvocationScope);
    return { content: [], details: {} };
  });
  const responses = [
    message,
    {
      ...makeAssistantMessage([{ type: "text", text: "done" }]),
      api: message.api,
      provider: message.provider,
      model: message.model,
    },
  ];
  await runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [{ ...makeTool("crabbox"), execute }] },
    {
      ...config,
      model: {
        ...config.model,
        api: message.api,
        provider: message.provider,
        id: message.model,
      },
    },
    (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        committed.push(event.message);
      }
    },
    undefined,
    () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected provider request");
      }
      return reply(response);
    },
  );
  return { committed, executedCallIds, executedScopes, execute };
}

describe("assistant tool invocation scope", () => {
  it.each(["provider response identity", "local fallback identity"])(
    "separates reused raw call ids across empty histories with %s",
    async (identity) => {
      const runs = [];
      for (const turn of [1, 2]) {
        runs.push(
          await runResponse(
            createResponse(
              identity === "provider response identity" ? `response-${turn}` : undefined,
            ),
          ),
        );
      }
      const scopes = runs.map((run) => run.executedScopes[0]);
      for (const [index, run] of runs.entries()) {
        expect(run.executedCallIds).toEqual(["crabbox_0"]);
        expect(scopes[index]).toMatchObject({ version: 1, id: expect.any(String) });
        expect(scopes[index]?.id.trim()).not.toBe("");
        expect(run.committed[0]?.content).toEqual([makeCall("crabbox", "crabbox_0")]);
      }
      expect(scopes[1]?.id).not.toBe(scopes[0]?.id);
    },
  );

  it("separates identical response and raw call ids across provider and API namespaces", async () => {
    const scopes = [];
    for (const namespace of [
      { provider: "provider-a", api: "openai-completions" },
      { provider: "provider-b", api: "openai-completions" },
      { provider: "provider-a", api: "anthropic-messages" },
    ] as const) {
      const run = await runResponse({ ...createResponse("shared-response"), ...namespace });
      expect(run.executedCallIds).toEqual(["crabbox_0"]);
      const scope = run.executedScopes[0];
      expect(scope).toMatchObject({ version: 1, id: expect.any(String) });
      scopes.push(scope?.id);
    }
    expect(new Set(scopes).size).toBe(3);
  });

  it("retains the recorded invocation scope when a committed response is JSON replayed", async () => {
    const original = await runResponse(createResponse());
    const committed = original.committed[0];
    expect(committed?.toolInvocationScope).toMatchObject({ version: 1, id: expect.any(String) });
    const persistedResponse = JSON.stringify(committed);
    const replay: AssistantMessage = JSON.parse(persistedResponse);
    expect(JSON.stringify(replay)).toBe(persistedResponse);

    const replayed = await runResponse(replay);

    expect(replayed.executedScopes).toEqual(original.executedScopes);
    expect(replayed.committed[0]?.toolInvocationScope).toEqual(committed?.toolInvocationScope);
    expect(replayed.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "unsupported version", scope: { version: 2, id: "recorded-scope" } },
    { name: "empty identity", scope: { version: 1, id: "" } },
    { name: "null scope", scope: null },
  ])("rejects a serialized $name before tool effects", async ({ scope }) => {
    const persistedResponse = JSON.stringify({ ...createResponse(), toolInvocationScope: scope });
    const message: AssistantMessage = JSON.parse(persistedResponse);
    const execute = vi.fn(async () => ({ content: [], details: {} }));

    await expect(
      runAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [{ ...makeTool("crabbox"), execute }] },
        config,
        () => {},
        undefined,
        () => reply(message),
      ),
    ).rejects.toThrow("Unsupported assistant tool invocation scope");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps admitted scope ownership when a later projection mutates the producer's input alias", async ({
    signal,
  }) => {
    const response = createAssistantMessageEventStream();
    const firstStarted = createDeferred();
    const sourceScope = { version: 1 as const, id: "prepared-scope" };
    const first: ReturnType<typeof makeCall> = { ...makeCall("crabbox", "first"), async: true };
    const second = makeCall("crabbox", "second");
    const committed: AssistantMessage[] = [];
    const committedSnapshots: AssistantMessage[] = [];
    const effects: Array<{ callId: string; scopeId: string | undefined }> = [];
    const execute = vi.fn(async (callId: string) => {
      const owner = getAgentToolExecutionContext()?.assistantMessage;
      expect(committed).toContain(owner);
      effects.push({ callId, scopeId: owner?.toolInvocationScope?.id });
      if (callId === "first") {
        firstStarted.resolve();
      }
      return { content: [], details: {} };
    });
    let requests = 0;
    const run = runAgentLoop(
      [user()],
      { systemPrompt: "", messages: [], tools: [{ ...makeTool("crabbox"), execute }] },
      config,
      (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          committed.push(event.message);
          committedSnapshots.push(structuredClone(event.message));
        }
      },
      undefined,
      () =>
        requests++ === 0 ? response : reply(makeAssistantMessage([{ type: "text", text: "done" }])),
    );
    const prefix = { ...makeAssistantMessage([first]), toolInvocationScope: sourceScope };
    let closed = false;
    try {
      response.push({ type: "start", partial: makeAssistantMessage([]) });
      response.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: prefix });
      await withinTest(
        awaitGateBeforeSettlement(firstStarted.promise, run, "First scoped call did not start"),
        signal,
      );

      sourceScope.id = "mutated-by-producer";
      response.push({
        type: "done",
        reason: "toolUse",
        message: { ...makeAssistantMessage([first, second]), toolInvocationScope: sourceScope },
      });
      response.end();
      closed = true;
      await run;

      expect(effects).toEqual([
        { callId: "first", scopeId: "prepared-scope" },
        { callId: "second", scopeId: "prepared-scope" },
      ]);
      for (const messages of [committed, committedSnapshots]) {
        expect(
          messages
            .filter((message) => message.content.some((block) => block.type === "toolCall"))
            .map((message) => message.toolInvocationScope?.id),
        ).toEqual(["prepared-scope", "prepared-scope"]);
      }
    } finally {
      if (!closed) {
        response.push({ type: "done", reason: "toolUse", message: prefix });
        response.end();
      }
      await run;
    }
  });

  it("does not start a tool when its assistant message_end persistence rejects", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const rejected = new Error("Assistant transcript commit rejected");

    await expect(
      runAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [{ ...makeTool("crabbox"), execute }] },
        config,
        (event) => {
          if (event.type === "message_end" && event.message.role === "assistant") {
            throw rejected;
          }
        },
        undefined,
        () => reply(createResponse()),
      ),
    ).rejects.toBe(rejected);
    expect(execute).not.toHaveBeenCalled();
  });
});
