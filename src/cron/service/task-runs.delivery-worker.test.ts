import { afterEach, expect, it, vi } from "vitest";
import * as taskExecutor from "../../tasks/task-executor.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { tryCreateCronTaskRunHandle, tryFinishCronTaskRun } from "./task-runs.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
});

it("projects command delivery status through the task worker", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-command-delivery-worker-" },
    async () => {
      resetTaskRegistryForTests();
      const startedAt = 2_000;
      const job: CronJob = {
        id: "command-delivery-worker",
        name: "command delivery worker",
        enabled: true,
        createdAtMs: 100,
        updatedAtMs: 100,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["synthetic-command"] },
        state: { nextRunAtMs: 60_000 },
      };
      const state = createCronServiceState({
        storePath: "/tmp/jobs.json",
        cronEnabled: true,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: () => startedAt + 100,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = tryCreateCronTaskRunHandle({ state, job, startedAt })?.runId;
      if (!taskRunId) {
        throw new Error("expected cron task run id");
      }
      const nativeDeliveryWrite = vi.spyOn(
        taskExecutor,
        "setDetachedTaskDeliveryStatusByRunIdCore",
      );

      tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          completionStatus: "failed",
          error: "synthetic delivery failure",
          delivered: false,
          deliveryStatus: "not-delivered",
          runAtMs: startedAt,
          durationMs: 100,
        },
      });

      expect(nativeDeliveryWrite).not.toHaveBeenCalled();
      await vi.waitFor(
        () => {
          const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
            runtime: "cron",
            sourceId: job.id,
          });
          expect(row).toMatchObject({
            status: "failed",
            deliveryStatus: "failed",
            detail: { kind: "cron-run", deliveryStatus: "not-delivered" },
          });
        },
        { timeout: 5_000 },
      );
    },
  );
});
