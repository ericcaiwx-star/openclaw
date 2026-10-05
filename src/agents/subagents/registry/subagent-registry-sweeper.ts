import type { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import {
  blockSubagentCompletionDelivery,
  reconcileRetiredSubagentCancellation,
} from "../completion/subagent-completion-admission.store.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createInterruptedRecoveryCoordinator } from "./subagent-registry-restart-recovery-coordinator.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import {
  discardSuspendedPendingFinalDelivery,
  isSuspendedPendingFinalDelivery,
  SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS,
  warnSuspendedDeliveryPressure,
} from "./subagent-registry-suspended-delivery.js";
import {
  deleteSweptSession,
  mutateCleanup,
  freezeCleanupSessionIdentity,
  shouldRunSweptSessionEffects,
  sweptContext,
  isSessionCleanupDeferred,
  isCollectorArchiveReady,
  isCleanupCurrent,
  type FrozenSessionIdentity,
} from "./subagent-registry-sweep-cleanup.js";
import {
  reconcileDurableSubagentKillIntent,
  reconcileProvisionalSubagentKill,
} from "./subagent-registry-sweep-kill.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";
export { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const STALE_ACTIVE_SUBAGENT_GRACE_MS = isFastTestRuntimeEnv() ? 1_000 : 60_000;
const restartRecoveryLoader = createLazyImportLoader(
  () => import("./subagent-registry-restart-recovery.js"),
);
const killRuntimeLoader = createLazyImportLoader(() => import("./subagent-control.runtime.js"));
type CompletionRuntime = ReturnType<typeof createSubagentRegistryCompletionRuntime>;

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: CompletionRuntime["completeSubagentRunWithRecovery"];
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  finalizeInterruptedSubagentRun: CompletionRuntime["finalizeInterruptedSubagentRun"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  deleteSuspendedSubagentSession: SubagentLifecycleController["deleteSuspendedSubagentSession"];
  isCleanupOwnerCurrent: SubagentLifecycleController["isCleanupOwnerCurrent"];
  sessionEffectsHostCurrent: SubagentLifecycleController["sessionEffectsHostCurrent"];
  shouldSuppressSessionEffects: SubagentLifecycleController["shouldSuppressSessionEffects"];
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requesterSessionKey: string,
    groupId: string,
    requesterAgentId?: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, resumedRuns } = params;
  let intervalStarted = false;
  let scheduled: { timer: NodeJS.Timeout; at: number } | undefined;
  let sweepInProgress = false;
  let rerunRequested = false;
  let lastWarnedSuspendedCount: number | undefined;
  const pendingWork = new Set<Promise<unknown>>();

  function trackWork<T>(run: () => Promise<T>): Promise<T> {
    const pending = run();
    pendingWork.add(pending);
    const settled = () => pendingWork.delete(pending);
    void pending.then(settled, settled);
    return pending;
  }

  function start() {
    if (intervalStarted) {
      return;
    }
    intervalStarted = true;
    schedule({ delayMs: 60_000 });
  }

  function stop() {
    recovery.reset();
    intervalStarted = false;
    clearTimeout(scheduled?.timer);
    scheduled = undefined;
    rerunRequested = false;
  }

  function schedule(options?: { delayMs?: number }) {
    const delayMs = Math.max(0, options?.delayMs ?? 5_000);
    const nextAt = Date.now() + delayMs;
    if (scheduled && scheduled.at <= nextAt) {
      return;
    }
    clearTimeout(scheduled?.timer);
    const timer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        scheduled = undefined;
        void trackWork(runTick);
      }, delayMs),
    );
    timer.unref?.();
    scheduled = { timer, at: nextAt };
  }

  async function runTick() {
    if (sweepInProgress) {
      rerunRequested = true;
      return;
    }
    try {
      await runWithGatewayDetachedWorkAdmission(sweepOnce, "subagents:sweeper");
    } catch (error) {
      if (isGatewayRestartDrainError(error)) {
        return params.warn("subagent run sweep skipped: gateway is draining for restart");
      }
      params.warn(
        `subagent run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (rerunRequested) {
      rerunRequested = false;
      schedule({ delayMs: 0 });
    } else if (intervalStarted) {
      schedule({ delayMs: 60_000 });
    }
  }

  const recovery = createInterruptedRecoveryCoordinator({
    runs,
    getRunsForChildSession: params.getRunsForChildSession,
    getGatewayRuntime: params.getGatewayRecoveryRuntime,
    finalizeRun: params.finalizeInterruptedSubagentRun,
    recoverRow: async (recoveryParams) =>
      (await restartRecoveryLoader.load()).recoverInterruptedSubagentRow(recoveryParams),
    schedule: (delayMs) => schedule({ delayMs }),
    warn: params.warn,
  });

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    // Cleanup can outlive the tick as well as the request that armed its timer.
    void trackWork(() =>
      runWithGatewayDetachedWorkAdmission(run, "subagents:sweeper-cleanup").catch(
        (error: unknown) => params.warn(`subagent sweep ${label} failed`, { runId, error }),
      ),
    );
  }

  async function sweepOnce() {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    try {
      const now = Date.now();
      recovery.prune();
      const collectorArchiveCandidates = new Map<
        string,
        { requesterSessionKey: string; groupId: string; requesterAgentId?: string }
      >();
      const phase = ([runId, entry]: [string, SubagentRunRecord]) =>
        entry.requesterSettleWake
          ? 0
          : isSuspendedPendingFinalDelivery(entry)
            ? 1
            : entry.terminalOwner === "interrupted-recovery"
              ? 2
              : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
                ? 3
                : entry.killReconciliation
                  ? 4
                  : 5;
      const runEntries = [...runs.entries()].toSorted((left, right) => {
        const phaseDelta = phase(left) - phase(right);
        return (
          phaseDelta ||
          (phase(left) === 3
            ? Number(isStaleUnendedSubagentRun(right[1], now)) -
              Number(isStaleUnendedSubagentRun(left[1], now))
            : 0)
        );
      });
      // Completion stays fresh across awaits, but deletion must retain the earlier
      // CAS identity. Bind it to the exact run so replacements wait for another pass.
      const cleanupIdentities = new Map<object, FrozenSessionIdentity | undefined>();
      for (const [, entry] of runEntries) {
        if (
          typeof entry.execution.endedAt !== "number" ||
          isRestoredQueuedFailureSettlementClaimed(entry) ||
          entry.requesterSettleWake ||
          isSuspendedPendingFinalDelivery(entry) ||
          entry.killIntent ||
          entry.killReconciliation ||
          !(entry.collect && entry.collectorCompletion
            ? entry.collectorLaunchCleanupPending || isCollectorArchiveReady(entry, now)
            : entry.archiveAtMs && entry.archiveAtMs <= now && !isSessionCleanupDeferred(entry))
        ) {
          continue;
        }
        // Suppressed session cleanup still requires the captured member for artifact cleanup.
        cleanupIdentities.set(getSubagentRunRuntimeKey(entry), freezeCleanupSessionIdentity(entry));
      }
      for (const [runId, snapshot] of runEntries) {
        const selected = runs.get(runId);
        if (!selected || !isSameSubagentRunOwner(selected, snapshot)) {
          continue;
        }
        let entry: SubagentRunRecord = selected;
        if (isRestoredQueuedFailureSettlementClaimed(entry)) {
          // The restored FIFO callback owns this row until durable settlement.
          continue;
        }
        if (
          subagentRuns.isCompletionAuthorityRetired(entry) &&
          ["pending", "in_progress"].includes(entry.delivery?.status ?? "")
        ) {
          await blockSubagentCompletionDelivery({
            subagent: entry,
            reason: "store replaced",
            suspendedReason: "permanent_failure",
            storeReplaced: true,
          });
          continue;
        }
        if (
          entry.killReconciliation &&
          (await reconcileRetiredSubagentCancellation(entry, now)) === false
        ) {
          continue;
        }
        const reconciled = runs.get(runId);
        if (!reconciled || !isSameSubagentRunOwner(reconciled, entry)) {
          continue;
        }
        entry = reconciled;
        // Yield freezes the parent's wake before its children finish. Keep
        // terminal delivery priority while unfinished children reach recovery.
        if (
          entry.requesterSettleWake &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry) &&
          !entry.execution.restartRecovery
        ) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const expired =
            now - (entry.delivery?.suspendedAt ?? now) >= SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS;
          if (expired) {
            await discardSuspendedPendingFinalDelivery({
              runId,
              entry,
              now,
              reason: "expired",
              resumedRuns,
              clearPendingLifecycleError: params.clearPendingLifecycleError,
              clearPendingLifecycleTimeout: params.clearPendingLifecycleTimeout,
              discardTerminalDelivery: params.discardTerminalDelivery,
              completeCleanupBookkeeping: params.completeCleanupBookkeeping,
              deleteSuspendedSubagentSession: params.deleteSuspendedSubagentSession,
              isCurrent: () => params.isCleanupOwnerCurrent(entry),
