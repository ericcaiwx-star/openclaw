import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSession } = await loadCompactHooksHarness();
const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");
const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabasesForTest }] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

it("keeps an explicit agentId when compacting a literal global session", async () => {
  const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-global-owner-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  const sessionTarget = {
    agentId: "main",
    sessionId: "compaction-global-owner",
    sessionKey: "global",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { compaction: { model: "openai/admitted-model" } },
      entries: { main: {}, work: {} },
    },
  };

  const parent = new AsyncWorkScope();
  try {
    await parent.run(() =>
      compactEmbeddedAgentSession({
        ...sessionTarget,
        sessionTarget,
        sessionFile: sessionTarget.sessionKey,
        workspaceDir,
        allowGatewaySubagentBinding: true,
        provider: "openai",
        model: "gpt-5.6-luna",
        config,
        enqueue: async (task) => await task(),
      }),
    );
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [parent],
      () => parent.drain(),
    );
  }

  const { snapshot } = await expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.mock.results[0]?.value,
    "admitted runtime lease",
  );
  const derive = expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.mock.calls[0]?.[1]?.deriveRuntimePluginSelections,
    "admitted compaction selection recipe",
  );
  expect(() => derive({ config, metadataSnapshot: snapshot.metadataSnapshot })).not.toThrow();
  expect(derive({ config, metadataSnapshot: snapshot.metadataSnapshot })).toMatchObject([
    { provider: "openai", modelId: "admitted-model", agentId: "main" },
  ]);
});
