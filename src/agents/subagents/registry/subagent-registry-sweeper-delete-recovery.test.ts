import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const recoverRow = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
const detachedTaskRuntime = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn(() => [] as unknown[]),
  findDetachedTaskRun: vi.fn(() => undefined as unknown),
}));
const killRuntime = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => false),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));
const killSessionEntry = vi.hoisted(() => ({
  current: undefined as
    | { sessionId: string; lifecycleRevision?: string; updatedAt: number }
    | undefined,
}));

vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return { ...actual, recoverInterruptedSubagentRow: recoverRow };
});
vi.mock("../../../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/agent-events.js")>()),
  isAgentEventLifecycleGenerationCurrent: () => true,
}));
vi.mock("../../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/agent-run-registry.js")>()),
  getAgentRunContext,
}));
vi.mock("../../internal-session-effects.js", () => ({ removeInternalSessionEffectsSession }));
vi.mock("../../../tasks/detached-task-runtime.js", () => detachedTaskRuntime);
vi.mock("./subagent-control.runtime.js", () => killRuntime);
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-session-reconciliation.js")>();
  return {
    ...actual,
    loadSubagentSessionEntry: vi.fn(() => killSessionEntry.current),
  };
});

function createHarness(runtime: { current?: GatewayRecoveryRuntime }) {
  const entry = createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "recover after restart",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
  const runs = new Map([[entry.runId, entry]]);
  const callGateway = vi.fn();
  const notifyContextEngineSubagentEnded = vi.fn();
  const warn = vi.fn();
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns: new Set(),
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery: vi.fn(),
    getGatewayRecoveryRuntime: () => runtime.current,
    abandonSubagentRestartRecoveryLaunch: vi.fn(() => true),
    clearAcceptedSubagentRestartRecovery: vi.fn(() => true),
    clearPendingSubagentRecoveryNotice: vi.fn(() => true),
    resumeSettledSubagentRestartRecovery: vi.fn(() => true),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    markSubagentRestartRecoveryLaunchAttempted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      lifecycleGeneration: params.lifecycleGeneration,
      phase: "attempted" as const,
    })),
    markSubagentRestartRecoveryLaunchAccepted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "accepted" as const,
    })),
    markSubagentRestartRecoveryLaunchConsumed: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "consumed" as const,
    })),
    reserveSubagentRestartRecoveryLaunch: vi.fn(
      (params: { idempotencyKey: string }) => params.idempotencyKey,
    ),
    resetSubagentRestartRecoveryLaunchAttempt: vi.fn(() => true),
    finalizeInterruptedSubagentRun: vi.fn(async () => 0),
    resumeRequesterSettleWake: vi.fn(),
    startSubagentAnnounceCleanupFlow: vi.fn(() => true),
    completeCleanupBookkeeping: vi.fn(),
    discardTerminalDelivery: vi.fn(),
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun: vi.fn(),
    callGateway,
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded,
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: (childSessionKey) =>
      [...runs.values()].filter((candidate) => candidate.childSessionKey === childSessionKey),
    getRunsForCollectorGroup: (requesterSessionKey, groupId) =>
      [...runs].filter(
        ([, candidate]) =>
          candidate.collect &&
          candidate.groupId === groupId &&
          (candidate.swarmRequesterSessionKey ?? candidate.requesterSessionKey) ===
            requesterSessionKey,
      ),
    warn,
  });
  return { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper, warn };
}

describe("subagent registry delete recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    recoverRow.mockReset();
    vi.mocked(loadSubagentSessionEntry)
      .mockReset()
      .mockImplementation(() => killSessionEntry.current);
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    killRuntime.abortEmbeddedAgentRun.mockReset().mockReturnValue(false);
    killRuntime.isEmbeddedAgentRunActive.mockReset().mockReturnValue(false);
    killRuntime.clearSessionQueues.mockReset().mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "session-revision",
      updatedAt: Date.now(),
    };
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReset().mockReturnValue([]);
    detachedTaskRuntime.findDetachedTaskRun.mockReset().mockReturnValue(undefined);
    removeInternalSessionEffectsSession.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("archives a retired recovery row without deleting its newer child session", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("does not delete a live successor when a dispatched delete row expires", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.cleanupCompletedAt = now - 5_000;
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };
    killSessionEntry.current = {
      sessionId: "successor-session",
      lifecycleRevision: "successor-revision",
      updatedAt: now,
    };

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retries an unfinished dispatched delete against its persisted identity at expiry", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.cleanupCompletedAt = undefined;
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };

    await sweeper.sweepOnce();

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          expectedSessionId: "original-session",
          expectedLifecycleRevision: "original-revision",
        }),
      }),
    );
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      agentDir: undefined,
      childSessionKey: entry.childSessionKey,
      reason: "swept",
      workspaceDir: undefined,
    });
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retains an unfinished dispatched delete when the expiry retry fails", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper, warn } =
      createHarness({ current: {} as GatewayRecoveryRuntime });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };
    const failure = new Error("gateway unavailable");
    callGateway.mockRejectedValueOnce(failure);

    await sweeper.sweepOnce();

    expect(runs.get(entry.runId)).toBe(entry);
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "sessions.delete failed during subagent sweep; keeping run for retry",
      expect.objectContaining({ runId: entry.runId, error: failure }),
    );
  });
});
