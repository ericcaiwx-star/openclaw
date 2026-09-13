import { afterEach, describe, expect, test, vi } from "vitest";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  getSubagentRunByRunId,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { callGateway } from "./call.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-delete-give-up-");

const RUN_ID = "run-gw-delete-give-up";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-delete-give-up";
const REQUESTER_SESSION_KEY = "agent:main:main";

afterEach(() => {
  subagentRegistryTesting.setDepsForTest();
  resetSubagentRegistryForTests({ persist: false });
});

describe("delete give-up fence through a real gateway", () => {
  test("fences an expired optional delete before its retained row is archived", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    const now = Date.now();
    const parentSessionId = "sess-gw-give-up-parent";
    const successorSessionId = "sess-gw-give-up-successor";
    const successorRevision = "rev-gw-give-up-successor";
    const deleteCalls: unknown[] = [];

    await writeSessionStore({
      entries: {
        [REQUESTER_SESSION_KEY]: {
          sessionId: parentSessionId,
          updatedAt: now,
        },
        [CHILD_SESSION_KEY]: {
          sessionId: successorSessionId,
          updatedAt: now,
          spawnedBy: REQUESTER_SESSION_KEY,
          lifecycleRevision: successorRevision,
        },
      },
    });

    const expiredOptionalRun: SubagentRunRecord = {
      runId: RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "give up without deleting a same-key successor",
      cleanup: "delete",
      createdAt: now - 7 * 60_000,
      expectsCompletionMessage: false,
      cleanupHandled: false,
      archiveAtMs: now + 60_000,
      execution: {
        status: "terminal",
        startedAt: now - 7 * 60_000,
        endedAt: now - 6 * 60_000,
        outcome: { status: "timeout" },
      },
      completion: { required: false },
      delivery: { status: "pending" },
    };
    saveSubagentRegistryToSqlite(new Map([[RUN_ID, expiredOptionalRun]]));

    const callLiveGateway = async (options: { method: string; params?: unknown }) => {
      if (options.method === "sessions.delete") {
        deleteCalls.push(options.params);
      }
      const res = await rpcReq<Record<string, unknown>>(
        gatewaySuite.ws,
        options.method,
        options.params,
      );
      if (!res.ok) {
        throw new Error(`gateway ${options.method} failed: ${JSON.stringify(res.error)}`);
      }
      return res.payload;
    };
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      callGateway: callLiveGateway as unknown as typeof callGateway,
    });
    initSubagentRegistry();
    activateSubagentRegistry(
      () =>
        ({
          resolveGatewayContext: () => ({
            recoveryRuntime: {
              dispatchAgent: vi.fn(),
              waitForAgent: vi.fn(),
              sendRecoveryNotice: vi.fn(),
            },
          }),
        }) as never,
    );

    const fenced = await vi.waitFor(
      () => {
        const entry = getSubagentRunByRunId(RUN_ID);
        expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
        expect(entry?.execution.suppressSessionEffects).toBe(true);
        expect(entry?.deleteCleanupDispatchedAt).toBeUndefined();
        expect(entry?.deleteCleanupTarget).toBeUndefined();
        return entry!;
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(loadSubagentRegistryFromSqlite().get(RUN_ID)?.execution.suppressSessionEffects).toBe(
      true,
    );
    expect(deleteCalls).toEqual([]);

    fenced.archiveAtMs = now - 1;
    fenced.requesterSettleWake = undefined;
    await subagentRegistryTesting.sweepOnceForTests();
    expect(getSubagentRunByRunId(RUN_ID)).toBeUndefined();
    expect(deleteCalls).toEqual([]);

    const listed = await rpcReq<{ sessions: Array<{ key: string }> }>(
      gatewaySuite.ws,
      "sessions.list",
      { includeUnknown: true },
    );
    expect(listed.ok).toBe(true);
    expect(listed.payload?.sessions.map((row) => row.key)).toContain(CHILD_SESSION_KEY);

    const verdict = {
      surface: "isolated-gateway",
      path: "expired optional delete give-up",
      durableFence: true,
      dispatchTarget: null,
      expiry: {
        presentAfterSweep: false,
        sessionsDeleteCalls: deleteCalls.length,
        successorSessionListed: true,
      },
    };
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
  });
});
