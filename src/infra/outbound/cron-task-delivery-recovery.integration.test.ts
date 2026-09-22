import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { createCommandCronDeliveryCustody } from "./delivery-completion.js";
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

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    stateDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetTaskRegistryForTests({ persist: false });
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
});
