import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createLog,
  resetRuntimeServiceMocks,
  runtimeServiceMocks,
} from "./server-runtime-services.test-harness.js";

const { activateGatewayScheduledServices } = await import("./server-runtime-services.js");

// Scheduler ownership only; the native Gateway matrix exercises real queue leases.
describe("outbound lease recovery wake", () => {
  let services: ReturnType<typeof activateGatewayScheduledServices> | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    resetRuntimeServiceMocks();
    setRuntimeConfigSnapshot({}, {});
  });
  afterEach(async () => {
    try {
      await services?.stopScheduledServices();
    } finally {
      services = undefined;
      vi.useRealTimers();
      clearRuntimeConfigSnapshot();
      resetGatewayWorkAdmission();
    }
  });

  it.each([false, true])(
    "retains the wake for a leased row, stopped before expiry: %s",
    async (stopEarly) => {
      let pending = true;
      const leaseUntil = Date.now() + 60_000;
      const reconcile = vi.fn();
      runtimeServiceMocks.countPendingDeliveryQueueEntries.mockImplementation(async (names) =>
        names.includes("outbound-prepared-v1") && pending ? 1 : 0,
      );
      runtimeServiceMocks.recoverPendingDeliveries.mockImplementationOnce(async (options) => {
        options.onPending?.();
        return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
      });
      runtimeServiceMocks.drainPendingDeliveries.mockImplementation(async (options) => {
        // The existing owner skips a live lease and therefore does not report an eligible row.
        expect(options.selectEntry({} as never, Date.now())).toEqual({
          match: true,
          bypassBackoff: false,
        });
        if (Date.now() >= leaseUntil) {
          reconcile();
          pending = false;
        }
      });
      services = activateGatewayScheduledServices({
        scheduler: createTestGatewayScheduler("fake-timers"),
        minimalTestGateway: false,
        cfgAtStart: {},
        deps: {} as never,
        sessionDeliveryRecoveryMaxEnqueuedAt: 123,
        log: createLog(),
      });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtimeServiceMocks.drainPendingDeliveries).toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      if (stopEarly) {
        await services.stopDeliveryRecovery();
      }
      const attemptsBeforeExpiry = runtimeServiceMocks.drainPendingDeliveries.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      if (stopEarly) {
        expect(reconcile).not.toHaveBeenCalled();
        expect(runtimeServiceMocks.drainPendingDeliveries).toHaveBeenCalledTimes(
          attemptsBeforeExpiry,
        );
      } else {
        expect(reconcile).toHaveBeenCalledOnce();
        const settledAttempts = runtimeServiceMocks.drainPendingDeliveries.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(runtimeServiceMocks.drainPendingDeliveries).toHaveBeenCalledTimes(settledAttempts);
      }
    },
  );
});
