/** Tests Code Mode skills and read tools. */

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import {
  readCodeModeSkill,
  resolveCodeModeSkills,
  resolveSkillRelativePath,
  type CodeModeSkill,
} from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

describe("Code Mode skills and read tools", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("keeps Code Mode skill parsing aligned with the production prompt renderer", () => {
    const entries = [createFixtureSkillEntry("alpha"), createFixtureSkillEntry("beta")];
    const skillsPrompt = resolveSkillsPrompt({
      entries,
      workspaceDir: "/workspace",
    });

    expect(
      resolveCodeModeSkills({
        skillsPrompt,
        candidates: entries.map((entry) => entry.skill),
      }).map(({ name, location }) => ({ name, location })),
    ).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md" },
      { name: "beta", location: "/skills/beta/SKILL.md" },
    ]);
  });

  it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads a skill-root relative file and rejects path escape", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) => {
      if (location === "/guest/skills/demo/modules/during-dining.md") {
        return "# dining module\n";
      }
      return "# skill\n";
    });
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const moduleBody = await skills.read("demo", "modules/during-dining.md");
        let escaped;
        try {
          await skills.read("demo", "../secret.md");
        } catch (error) {
          escaped = error.message;
        }
        return { moduleBody, escaped };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      moduleBody: "# dining module\n",
      escaped: 'invalid skill relative path "../secret.md"',
    });
    expect(codeModeTools[0]?.description).toContain("skills.read(name,");
    expect(resolveSkillRelativePath("/host/skills/demo/SKILL.md", "modules/during-dining.md")).toBe(
      "/host/skills/demo/modules/during-dining.md",
    );
    await expect(readCodeModeSkill(codeModeSkills[0]!, undefined, "../etc/passwd")).rejects.toThrow(
      /invalid skill relative path/,
    );
  });

  it("reads a node-hosted skill module through the locator reader", async () => {
    const reader = vi.fn(async ({ location }: { location: string }) => {
      if (location === "node://node-1/skills/demo/modules/during-dining.md") {
        return "# dining module\n";
      }
      return "# skill\n";
    });
    const skill: CodeModeSkill = {
      name: "demo",
      description: "demo",
      location: "node://node-1/skills/demo/SKILL.md",
      source: {
        filePath: "node://node-1/skills/demo/SKILL.md",
        readContent: "# skill\n",
      },
      reader,
    };
    await expect(readCodeModeSkill(skill, undefined, "modules/during-dining.md")).resolves.toBe(
      "# dining module\n",
    );
    expect(reader).toHaveBeenCalledWith({
      location: "node://node-1/skills/demo/modules/during-dining.md",
      signal: undefined,
    });
    await expect(
      readCodeModeSkill({ ...skill, reader: undefined }, undefined, "modules/x.md"),
    ).rejects.toThrow(/node-hosted skill relative reads require a skill reader/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a real symlink that escapes the skill root",
    async () => {
      const tmpParent = await fs.realpath(
        await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-root-")),
      );
      const skillRoot = nodePath.join(tmpParent, "demo");
      const outside = nodePath.join(tmpParent, "outside.txt");
      await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
      await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
      await fs.writeFile(
        nodePath.join(skillRoot, "modules", "during-dining.md"),
        "# dining\n",
        "utf8",
      );
      await fs.writeFile(outside, "secret\n", "utf8");
      await fs.symlink(outside, nodePath.join(skillRoot, "modules", "link.md"));
      const skill: CodeModeSkill = {
        name: "demo",
        description: "demo",
        location: nodePath.join(skillRoot, "SKILL.md"),
        source: { filePath: nodePath.join(skillRoot, "SKILL.md") },
      };
      await expect(readCodeModeSkill(skill, undefined, "modules/during-dining.md")).resolves.toBe(
        "# dining\n",
      );
      await expect(readCodeModeSkill(skill, undefined, "modules/link.md")).rejects.toThrow(
        /escapes skill root/,
      );
      await fs.rm(tmpParent, { recursive: true, force: true });
    },
  );

  it.each([
    {
      name: "existing ordinary file",
      path: "notes.txt",
      content: "ordinary file content",
      expected: { kind: "text", content: "ordinary file content" },
    },
    {
      name: "missing implicitly optional daily memory",
      path: "memory/2026-05-15.md",
      expected: {
        kind: "not_found",
        status: "not_found",
        path: "memory/2026-05-15.md",
        optional: true,
      },
    },
  ])(
    "returns $name through the wrapped Code Mode boundary",
    async ({ path, content, expected }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const read = createOpenClawReadTool(
        createReadTool("/workspace", {
          operations: {
            access: async () => {
              if (content === undefined) {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
            },
            readFile: async () => Buffer.from(content ?? "unreachable"),
          },
        }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, read],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
        code: `return await read(${JSON.stringify({ path })});`,
      });

      expect(details).toMatchObject({ status: "completed", value: expected });
    },
  );
});
