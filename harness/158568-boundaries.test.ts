/**
 * Independent CI-only review probes for PR #158568.
 * Install at src/agents/embedded-agent-runner/run/review-158568-boundaries.test.ts.
 * No live provider/channel credentials. The stream and delivery receipt are synthetic.
 * Recovery-helper probes assert observed head behavior, not a product veto policy.
 * Agent probes run the actual Agent loop, tools, and installed terminal hook.
 */
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import { createAssistantMessageEventStream } from "../../../../packages/agent-core/src/llm.js";
import type { AgentEvent, AgentTool, StreamFn } from "../../../../packages/agent-core/src/types.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";
import { resolveSettledToolBatchEvidence } from "./incomplete-turn-recovery.js";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";

const rejection = "Provider returned an incomplete or malformed tool call";
const malformed = { errorMessage: rejection, content: [], diagnostics: [] };
afterEach(() => vi.restoreAllMocks());

describe("158568 independent recovery-head observations", () => {
  it("recognizes the incident's exact message without a structured error code and bounds this branch", async () => {
    const fixture = await recoverAfterTransportDrop(malformed);
    expect(fixture.recovery).toMatchObject({ action: "retry" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
      includeToolFailureInstruction: false,
    });
    expect(await fixture.recover()).toMatchObject({ action: "retry" });
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledTimes(2);
    expect(fixture.contextRecoveryState.malformedToolCallContinuationAttempts).toBe(2);
    expect(fixture.failoverRetryController.transientRetryCount).toBe(0);
  });

  it("passes the existing failure-reporting instruction flag after a settled failed tool", async () => {
    const fixture = await recoverAfterTransportDrop({
      ...malformed,
      failedToolCallId: "call_2",
      lastToolError: { toolName: "exec", error: "synthetic command failure" },
    });
    const settled = resolveSettledToolBatchEvidence(fixture.attempt);
    expect(settled.allToolsProvenSettled).toBe(true);
    expect(settled.failedToolNames.has("exec")).toBe(true);
    expect(fixture.recovery).toMatchObject({ action: "retry" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
      includeToolFailureInstruction: true,
    });
    // This proves forwarding of the flag, not that a real model tells the user.
  });

  it.each([
    ["missing result", { missingToolResult: true }],
    ["active tool", { activeCount: 1 }],
    ["async work", { asyncStarted: true }],
    ["intentional termination", { terminate: true }],
    ["yield", { yieldDetected: true }],
    ["approval", { didSendDeterministicApprovalPrompt: true }],
    ["harness-owned transport", { pluginHarnessOwnsTransport: true }],
    ["external cancellation", { terminal: { kind: "aborted", source: "external" } }],
    ["timeout", { terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true } }],
  ] as const)("does not enter the new branch for %s", async (_label, scenario) => {
    const fixture = await recoverAfterTransportDrop({ ...malformed, ...scenario });
    expect(fixture.contextRecoveryState.malformedToolCallContinuationAttempts ?? 0).toBe(0);
    // Other existing recovery families are deliberately not classified as this branch.
  });

  it("does not mistake a lookalike rejection message for the exact pre-dispatch contract", async () => {
    const fixture = await recoverAfterTransportDrop({ ...malformed, errorMessage: rejection + "." });
    expect(fixture.contextRecoveryState.malformedToolCallContinuationAttempts ?? 0).toBe(0);
  });

  it("a retained current tool call without its result fails the shared settlement gate", async () => {
    const fixture = await recoverAfterTransportDrop({
      ...malformed,
      content: [{ type: "toolCall", id: "unsettled-retained-call", name: "exec", arguments: {} }],
    });
    expect(resolveSettledToolBatchEvidence(fixture.attempt).allToolsProvenSettled).toBe(false);
    expect(fixture.contextRecoveryState.malformedToolCallContinuationAttempts ?? 0).toBe(0);
  });

  it("observes continuation even with preserved visible text on the errored model turn", async () => {
    const fixture = await recoverAfterTransportDrop({
      ...malformed,
      content: [{ type: "text", text: "Synthetic preserved response text" }],
      assistantTexts: ["Synthetic preserved response text"],
    });
    expect(resolveSettledToolBatchEvidence(fixture.attempt).allToolsProvenSettled).toBe(true);
    expect(fixture.recovery).toMatchObject({ action: "retry" });
    // Observes the recovery owner; does not claim text was delivered to a user.
  });
});

const model = {
  id: "synthetic-review-model",
  name: "Synthetic review model",
  api: "openai-completions" as const,
  provider: "deepseek",
  baseUrl: "https://example.test/never-contacted",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};

async function runProducerScenario(kind: "final-alone" | "final-mixed" | "accepted-spawn") {
  let providerRequests = 0;
  let deliveredSource = false;
  let completedOperations = 0;
  const events: AgentEvent[] = [];
  const calls = kind === "accepted-spawn"
    ? [{ type: "toolCall" as const, id: "review-spawn", name: "sessions_spawn", arguments: {} }]
    : [
        { type: "toolCall" as const, id: "review-message", name: "message", arguments: { action: "send", message: "Video delivered", final: true } },
        ...(kind === "final-mixed" ? [{ type: "toolCall" as const, id: "review-read", name: "read", arguments: {} }] : []),
      ];
  const streamFn: StreamFn = () => {
    providerRequests += 1;
    const assistant = buildEmbeddedRunnerAssistant({
      provider: model.provider,
      model: model.id,
      api: model.api,
      stopReason: providerRequests === 1 ? "toolUse" : "error",
      content: providerRequests === 1 ? calls : [],
      ...(providerRequests === 1 ? {} : { errorMessage: rejection }),
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistant });
    if (providerRequests === 1) {
      stream.push({ type: "done", reason: "toolUse", message: assistant });
    } else {
      stream.push({ type: "error", reason: "error", error: assistant });
    }
    stream.end();
    return stream;
  };
  const makeTool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
    name,
    label: name,
    description: "Synthetic review tool",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute,
  });
  const tools = [
    makeTool("message", async () => {
      completedOperations += 1;
      return {
        content: [{ type: "text", text: "synthetic source reply receipt" }],
        details: { messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [], sourceReplyDelivered: true } },
      };
    }),
    makeTool("read", async () => ({ content: [{ type: "text", text: "read complete" }], details: {} })),
    makeTool("sessions_spawn", async () => {
      completedOperations += 1;
      return { content: [{ type: "text", text: "accepted" }], details: { status: "accepted", runId: "synthetic-child", childSessionKey: "agent:main:subagent:synthetic-child", expectsCompletionMessage: true } };
    }),
  ];
  const agent = new Agent({
    initialState: { model, systemPrompt: "Synthetic review", tools },
    convertToLlm: (messages) => messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
    streamFn,
  });
  installMessageToolOnlyTerminalHook({
    agent,
    sourceReplyDeliveryMode: "message_tool_only",
    onDeliveredSourceReply: () => { deliveredSource = true; },
  });
  agent.subscribe((event) => events.push(event));
  await agent.prompt("Perform the synthetic operation once.");
  return { agent, events, providerRequests, deliveredSource, completedOperations };
}

describe("158568 actual Agent-loop producer reachability", () => {
  it("a single confirmed final message terminates before another model request", async () => {
    const observed = await runProducerScenario("final-alone");
    expect(observed.providerRequests).toBe(1);
    expect(observed.deliveredSource).toBe(true);
    expect(observed.completedOperations).toBe(1);
    expect(observed.events.find((event) => event.type === "tool_execution_end")).toMatchObject({ result: { terminate: true } });
  });

  it.each(["final-mixed", "accepted-spawn"] as const)(
    "%s can reach a later malformed model turn and is allowed by the new recovery branch",
    async (kind) => {
      const observed = await runProducerScenario(kind);
      expect(observed.providerRequests).toBe(2);
      expect(observed.completedOperations).toBe(1);
      expect(observed.deliveredSource).toBe(kind === "final-mixed");
      expect(observed.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: rejection });
      const toolEnds = observed.events.filter((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end");
      const accepted = toolEnds.flatMap((event) => {
        const spawn = normalizeAcceptedSessionSpawnResult(event.result);
        return spawn ? [spawn] : [];
      });
      expect(accepted.length).toBe(kind === "accepted-spawn" ? 1 : 0);
      // Rearm the helper on producer-generated transcript/results. The helper's
      // transport seam remains mocked; this does not prove an actual channel send
      // or a full Gateway run, and permitting continuation is not called a defect.
      const fixture = await recoverAfterTransportDrop(malformed);
      fixture.contextRecoveryState.malformedToolCallContinuationAttempts = 0;
      fixture.continueFromCurrentTranscript.mockClear();
      fixture.markOwnedTranscriptRetry.mockClear();
      Object.assign(fixture.attempt, {
        messagesSnapshot: observed.agent.state.messages,
        toolMetas: toolEnds.map((event) => ({ toolName: event.toolName, toolCallId: event.toolCallId, replaySafe: false, isError: event.isError, ...(event.result.terminate === true ? { terminate: true } : {}) })),
        itemLifecycle: { startedCount: toolEnds.length, completedCount: toolEnds.length, activeCount: 0 },
        acceptedSessionSpawns: accepted,
        sourceReplyDelivered: observed.deliveredSource,
        sourceReplyDeliveryState: observed.deliveredSource ? "delivered" : "missing",
        didDeliverSourceReplyViaMessageTool: observed.deliveredSource,
      });
      expect(resolveSettledToolBatchEvidence(fixture.attempt).allToolsProvenSettled).toBe(true);
      expect(resolveSettledToolBatchEvidence(fixture.attempt).intentionalTermination).toBe(false);
      expect(resolveSourceReplyDelivery(fixture.attempt)).toBe(kind === "final-mixed" ? "delivered" : "missing");
      expect(await fixture.recover()).toMatchObject({ action: "retry" });
      expect(fixture.contextRecoveryState.malformedToolCallContinuationAttempts).toBe(1);
      expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );
});
