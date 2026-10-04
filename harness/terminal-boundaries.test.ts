import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmptyResponseRetryInstruction } from "./incomplete-turn-recovery.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

type AttemptOverrides = Parameters<typeof makeEmbeddedRunnerAttempt>[0];
type AssistantOverrides = Parameters<typeof buildEmbeddedRunnerAssistant>[0];

function uploadSettledTurn(
  attemptOverrides: AttemptOverrides = {},
  assistantOverrides: AssistantOverrides = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    stopReason: "error",
    errorMessage: "Provider returned an incomplete or malformed tool call",
    content: [{ type: "thinking", thinking: "synthetic reasoning only" }],
    usage: {
      input: 2837,
      output: 564,
      cacheRead: 67584,
      cacheWrite: 0,
      totalTokens: 70985,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...assistantOverrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: [{ toolName: "exec", toolCallId: "synthetic-upload", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...attemptOverrides,
  });
  return makeTerminalInput({
    attempt,
    attemptAssistant: assistant,
    activeErrorContext: { provider: "deepseek", model: "deepseek-v4-flash" },
    modelApi: "openai-completions",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey: "synthetic:qq-upload",
    }),
  });
}

describe("Independent settled exec / rejected next call boundaries", () => {
  it.each([
    {},
    {
      content: [],
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
    },
  ] satisfies AssistantOverrides[])(
    "continues the persisted turn once and surfaces a persistent error after the budget",
    async (assistantOverrides) => {
      const input = uploadSettledTurn({}, assistantOverrides);
      const retryState = createEmbeddedRunTerminalRetryState();
      input.retryState = retryState;
      expect(input.attempt.replayMetadata.replaySafe).toBe(false);
      expect(input.payloadsWithToolMedia?.some((payload) => payload.isError)).toBe(true);

      expect(await resolveEmbeddedRunTerminal(input)).toEqual({ action: "retry" });
      expect(retryState.emptyResponseAttempts).toBe(1);
      expect(input.activateInternalPrompt).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Do not repeat completed tool calls"),
      );
      expect(input.setSuppressNextUserMessagePersistence).not.toHaveBeenCalled();

      const exhausted = await resolveEmbeddedRunTerminal(input);
      expect(exhausted.action).toBe("complete");
      if (exhausted.action === "complete") {
        expect(exhausted.result.meta.error?.kind).toBe("incomplete_turn");
      }
      expect(input.activateInternalPrompt).toHaveBeenCalledTimes(1);
    },
  );

  const blockedCases: {
    name: string;
    attempt?: AttemptOverrides;
    assistant?: AssistantOverrides;
  }[] = [
    {
      name: "still-running tool",
      attempt: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    },
    {
      name: "unsettled lifecycle without active item",
      attempt: { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 0 } },
    },
    {
      name: "tool failure",
      attempt: { lastToolError: { toolName: "exec", error: "synthetic upload failure" } },
    },
    {
      name: "asynchronous upload",
      attempt: { toolMetas: [{ toolName: "exec", asyncStarted: true, replaySafe: false }] },
    },
    { name: "yielded work", attempt: { yieldDetected: true } },
    {
      name: "accepted child completion",
      attempt: {
        acceptedSessionSpawns: [
          {
            runId: "synthetic-child",
            childSessionKey: "synthetic:child",
            expectsCompletionMessage: true,
          },
        ],
      },
    },
    { name: "pending approval", attempt: { didSendDeterministicApprovalPrompt: true } },
    { name: "delivered source reply", attempt: { sourceReplyDeliveryState: "delivered" } },
    { name: "committed source reply", attempt: { sourceReplyDeliveryState: "committed" } },
    { name: "terminal media reply", attempt: { hasToolMediaBlockReply: true } },
    {
      name: "already visible reply",
      attempt: { assistantTexts: ["synthetic final reply"] },
      assistant: { content: [{ type: "text", text: "synthetic final reply" }] },
    },
    {
      name: "unrelated provider error",
      assistant: { errorMessage: "synthetic connection failure" },
    },
    {
      name: "call not removed by transport",
      assistant: {
        content: [{ type: "toolCall", id: "synthetic-pending", name: "exec", arguments: {} }],
      },
    },
  ];

  it.each(blockedCases)("does not continue $name", async ({ attempt, assistant }) => {
    const input = uploadSettledTurn(attempt, assistant);
    expect((await resolveEmbeddedRunTerminal(input)).action).toBe("complete");
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it.each([
    { aborted: true, timedOut: false },
    { aborted: false, timedOut: true },
  ])("does not revive a cancelled or expired request: %j", (terminal) => {
    expect(
      resolveEmptyResponseRetryInstruction({
        provider: "deepseek",
        modelApi: "openai-completions",
        payloadCount: 1,
        attempt: uploadSettledTurn().attempt,
        ...terminal,
      }),
    ).toBeNull();
  });
});
