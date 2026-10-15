import { expect, it } from "vitest";
import {
  mountRoster,
  settleRoster,
  toggleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

for (const mode of ["chip", "roster"] as const) {
  it(`keeps self-parented Home navigable with child discovery in ${mode} mode`, async () => {
    const key = "agent:main:main";
    const { sidebar } = await mountRoster(undefined, [
      {
        key,
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        updatedAt: 1,
        childSessions: ["agent:main:child", "agent:main:subagent:review"],
        label: "Home",
        lastMessagePreview: "Home context",
      },
      {
        key: "agent:main:child",
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        spawnedBy: key,
        updatedAt: 2,
        label: "Child conversation",
      },
      {
        key: "agent:main:subagent:review",
        agentId: "main",
        kind: "direct",
        spawnedBy: key,
        updatedAt: 3,
        hasActiveRun: true,
        label: "Review worker",
      },
    ]);
    sidebar.sidebarAgentsMode = mode;
    await settleRoster(sidebar);
    const home = sidebar.projectHomeSession(sidebar.mainSessionRow()!, "main");
    expect(home.key).toBe(key);
    expect(home.subagentSummary?.runningChildCount).toBe(1);
    expect(home.childLoadParentKeys).toContain(key);
    expect(home.children?.map((row) => row.key)).toContain("agent:main:child");
    if (mode === "chip") {
      await toggleRoster(sidebar);
      await settleRoster(sidebar);
    }
    await toggleRoster(sidebar, "recent");
    await settleRoster(sidebar);
    expect(sidebar.expandedAgentId()).toBe("recent");
  });
}
