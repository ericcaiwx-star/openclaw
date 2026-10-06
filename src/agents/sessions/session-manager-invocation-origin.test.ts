import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop } from "../../../packages/agent-core/src/agent-loop.js";
import {
  config,
  makeAssistantMessage,
  makeCall,
  makeTool,
  reply,
  user,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from "../../../packages/agent-core/src/llm.js";
import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import type { StreamFn } from "../../../packages/agent-core/src/types.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "invocation-history-origin" });
});
afterAll(async () => {
  await state.cleanup();
});

function response(scoped = false): AssistantMessage {
  return {
    ...makeAssistantMessage([makeCall("lookup", "reused-call")]),
    responseId: "recorded-response",
    turnId: "recorded-turn",
    ...(scoped ? { toolInvocationScope: { version: 1, id: "recorded-scope" } } : {}),
  };
}

async function restore(
  admission: "fromEntries" | "openAsync" | "coreContext" | "coreResetContext",
  original: AssistantMessage,
  name: string,
) {
  if (admission === "coreContext" || admission === "coreResetContext") {
    const timestamp = "2026-01-01T00:00:01.000Z";
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "stored-call",
        parentId: admission === "coreResetContext" ? "retained-input" : null,
        timestamp,
        message: original,
      },
    ];
    if (admission === "coreResetContext") {
      entries.unshift({
        type: "message",
        id: "retained-input",
        parentId: null,
        timestamp,
        message: user("retained conversation"),
      });
      entries.push(
        {
          type: "message",
          id: "stored-result",
          parentId: "stored-call",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "reused-call",
            toolName: "lookup",
            content: [],
            isError: false,
            timestamp: 2,
          },
        },
        {
          type: "reset",
          id: "reset",
          parentId: "stored-result",
          timestamp,
          reason: "new",
          firstKeptEntryId: "retained-input",
        },
      );
    }
    const restored = buildCoreSessionContext(entries).messages.find(
      (message) => message.role === "assistant",
    );
    if (restored?.role !== "assistant") {
      throw new Error("Core history projection did not return its stored assistant call");
    }
    return restored;
  }
  let manager: SessionManager;
  if (admission === "fromEntries") {
    manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: name,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: state.workspaceDir,
      },
      {
        type: "message",
        id: "stored-call",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: original,
      },
    ]);
  } else {
    const target = {
      agentId: "main",
      sessionId: name,
      sessionKey: `agent:main:${name}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
    const writer = await SessionManager.openAsync(target, state.workspaceDir);
    await writer.appendMessageAsync(original);
    await closeOpenClawAgentDatabasesAsync(state.root);
    manager = await SessionManager.openAsync(target, state.workspaceDir);
  }
  const row = manager.getBranch().find((entry) => entry.type === "message");
  if (row?.type !== "message" || row.message.role !== "assistant") {
    throw new Error("History admission did not return its stored assistant call");
  }
  return row.message;
}

async function executeResponse(message: AssistantMessage, cloneTerminal = false) {
  const scopes: Array<string | undefined> = [];
  const calls: string[] = [];
  const committed: AssistantMessage[] = [];
  let requests = 0;
  await runAgentLoop(
    [user()],
    {
      systemPrompt: "",
      messages: [],
      tools: [
        {
          ...makeTool("lookup"),
          execute: async (callId) => {
            calls.push(callId);
            scopes.push(getAgentToolExecutionContext()?.assistantMessage.toolInvocationScope?.id);
            return { content: [], details: {} };
          },
        },
      ],
    },
    config,
    (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        committed.push(event.message);
      }
    },
    undefined,
    () => {
      if (requests++ > 0) {
        return reply(makeAssistantMessage([{ type: "text", text: "done" }]));
      }
      if (!cloneTerminal) {
        return reply(message);
      }
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      const final: AssistantMessage = structuredClone(message);
      stream.push({ type: "done", reason: "toolUse", message: final });
      stream.end();
      return stream;
    },
  );
  expect(requests).toBe(2);
  return { scopes, calls, committed };
}

describe("restored assistant invocation origin", () => {
  it.each([
    { admission: "fromEntries", scoped: false },
    { admission: "openAsync", scoped: false },
    { admission: "fromEntries", scoped: true },
    { admission: "openAsync", scoped: true },
    { admission: "coreContext", scoped: false },
    { admission: "coreContext", scoped: true },
    { admission: "coreResetContext", scoped: false },
  ] as const)(
    "executes $admission history without rekeying its recorded frame (scoped: $scoped)",
    async ({ admission, scoped }) => {
      const original = response(scoped);
      const bytes = JSON.stringify(original);
      const restored = await restore(admission, original, `${admission}-${scoped}`);
      expect(JSON.stringify(restored)).toBe(bytes);

      const executed = await executeResponse(restored);

      expect(executed.calls).toEqual(["reused-call"]);
      expect(executed.scopes).toEqual([scoped ? "recorded-scope" : undefined]);
      expect(JSON.stringify(executed.committed[0])).toBe(bytes);
      expect(JSON.stringify(restored)).toBe(bytes);
    },
  );

  it("preserves a restored legacy ordinary response when only its start projection carries history origin", async () => {
    const original = response();
    const bytes = JSON.stringify(original);
    const restored = await restore("fromEntries", original, "ordinary-terminal-clone");

    const executed = await executeResponse(restored, true);

    expect(executed.calls).toEqual(["reused-call"]);
    expect(executed.scopes).toEqual([undefined]);
    expect(JSON.stringify(executed.committed[0])).toBe(bytes);
    expect(JSON.stringify(restored)).toBe(bytes);
  });

  it("scopes an ordinary fresh response with the same serialized shape as legacy history", async () => {
    const fresh = response();

    const executed = await executeResponse(fresh);

    expect(executed.calls).toEqual(["reused-call"]);
    expect(executed.scopes[0]).toEqual(expect.any(String));
    expect(executed.scopes[0]?.trim()).not.toBe("");
    expect(executed.committed[0]?.toolInvocationScope?.version).toBe(1);
  });

  it("keeps a restored legacy async response legacy when its final projection is an unmarked clone", async ({
    signal,
  }) => {
    const first: ReturnType<typeof makeCall> = {
      ...makeCall("lookup", "legacy-first"),
      async: true,
    };
    const original = { ...response(), content: [first] };
    const bytes = JSON.stringify(original);
    const restored = await restore("fromEntries", original, "async-legacy");
    const stream = createAssistantMessageEventStream();
    const firstStarted = createDeferred();
    const effects: Array<{ callId: string; scopeId: string | undefined }> = [];
    const committed: AssistantMessage[] = [];
    let requests = 0;
    const streamFn: StreamFn = () =>
      requests++ === 0 ? stream : reply(makeAssistantMessage([{ type: "text", text: "done" }]));
    const run = runAgentLoop(
      [user()],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            ...makeTool("lookup"),
            execute: async (callId) => {
              effects.push({
                callId,
                scopeId: getAgentToolExecutionContext()?.assistantMessage.toolInvocationScope?.id,
              });
              if (callId === "legacy-first") {
                firstStarted.resolve();
              }
              return { content: [], details: {} };
            },
          },
        ],
      },
      config,
      (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          committed.push(event.message);
        }
      },
      undefined,
      streamFn,
    );
    let closed = false;
    try {
      stream.push({ type: "start", partial: makeAssistantMessage([]) });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: restored });
      await withinTest(
        awaitGateBeforeSettlement(firstStarted.promise, run, "Restored async call did not start"),
        signal,
      );
      const final: AssistantMessage = structuredClone(restored);
      final.content.push(makeCall("lookup", "legacy-second"));
      stream.push({ type: "done", reason: "toolUse", message: final });
      stream.end();
      closed = true;
      await run;

      expect(effects).toEqual([
        { callId: "legacy-first", scopeId: undefined },
        { callId: "legacy-second", scopeId: undefined },
      ]);
      const fragments = committed.filter((message) =>
        message.content.some((block) => block.type === "toolCall"),
      );
      expect(fragments.map((message) => message.toolInvocationScope)).toEqual([
        undefined,
        undefined,
      ]);
      expect(
        fragments
          .flatMap((message) => message.content)
          .filter((block) => block.type === "toolCall")
          .map((block) => block.id),
      ).toEqual(["legacy-first", "legacy-second"]);
      expect(JSON.stringify(fragments[0])).toBe(bytes);
    } finally {
      if (!closed) {
        stream.push({ type: "done", reason: "toolUse", message: restored });
        stream.end();
      }
      await run;
    }
  });
});
