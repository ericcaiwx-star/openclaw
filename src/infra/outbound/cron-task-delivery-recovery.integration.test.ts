import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { retryTransientDirectCronDelivery } from "../../cron/isolated-agent/delivery-dispatch-policy.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { createCommandCronDeliveryCustody } from "./delivery-completion.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("command cron delivery recovery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let stateDir: string;
  let taskStore: ReturnType<typeof createInMemoryTaskRegistryStore>;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    stateDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetTaskRegistryForTests({ persist: false });
    taskStore = createInMemoryTaskRegistryStore();
    configureTaskRegistryRuntime({ store: taskStore });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("restores serialized custody and settles the exact task after restart", async () => {
    const runId = "cron:job-recovery:1000:receipt-recovery";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-recovery",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "recover command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "recover once" }],
        queuePolicy: "required",
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
      },
      custody.deliveryIntentId,
      stateDir,
    );

    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({ store: taskStore });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "synthetic-message" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir,
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(getTaskById(task.taskId)).toMatchObject({
      runId,
      deliveryStatus: "delivered",
      detail: {
        deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
      },
    });
  });

  it("reuses the pending command intent after a proven no-send and then succeeds", async () => {
    const runId = "cron:job-retry:1000:receipt-retry";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-retry",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "retry command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("synthetic pre-send refusal", {
          cause: new Error("synthetic transport unavailable"),
        }),
      )
      .mockResolvedValueOnce({ channel: "matrix", messageId: "synthetic-retry-message" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    await expect(
      retryTransientDirectCronDelivery({
        jobId: "job-retry",
        run: () =>
          deliverOutboundPayloads({
            cfg: {} as OpenClawConfig,
            channel: "matrix",
            to: "!synthetic:example",
            payloads: [{ text: "retry once" }],
            deps: {},
            queuePolicy: "required",
            deliveryQueueStateDir: stateDir,
            deliveryIntentId: custody.deliveryIntentId,
            deliveryCompletion: custody.deliveryCompletion,
            completionRetention: custody.completionRetention,
            reusePendingDeliveryIntent: true,
          }),
      }),
    ).resolves.toMatchObject([{ messageId: "synthetic-retry-message" }]);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(getTaskById(task.taskId)).toMatchObject({
      deliveryStatus: "delivered",
      detail: { deliveryEvidence: { state: "delivered" } },
    });
  });

  it("retains queue custody when task evidence storage is unavailable", async () => {
    const runId = "cron:job-storage:1000:receipt-storage";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-storage",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "retain command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    taskStore.runInitialMutationAsync = async () => {
      throw new Error("synthetic task storage unavailable");
    };
    const sendMatrix = vi.fn();

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "retain custody" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryQueueStateDir: stateDir,
        deliveryIntentId: custody.deliveryIntentId,
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).rejects.toThrow("synthetic task storage unavailable");

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, custody.deliveryIntentId, stateDir),
    ).toBe("pending");
  });
});
