// Exclusive-create recovery for existing workspace bootstrap files.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { DEFAULT_AGENTS_FILENAME, ensureAgentWorkspace } from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-exclusive-create-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

function exclusiveCreateFlag(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null || !("flag" in options)) {
    return undefined;
  }
  return typeof options.flag === "string" ? options.flag : undefined;
}

async function withExclusiveCreateError(
  filePath: string,
  code: string,
  run: () => Promise<void>,
): Promise<void> {
  const originalWriteFile = fs.writeFile.bind(fs);
  const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation((async (target, data, options) => {
    if (target === filePath && exclusiveCreateFlag(options) === "wx") {
      throw Object.assign(new Error(`${code}: exclusive create failed, open`), { code });
    }
    return await originalWriteFile(target, data, options as never);
  }) as typeof fs.writeFile);
  try {
    await run();
  } finally {
    writeSpy.mockRestore();
  }
}

describe("ensureAgentWorkspace exclusive create", () => {
  it.each(["EPERM", "EACCES"] as const)(
    "keeps an existing bootstrap file when exclusive create reports %s",
    async (code) => {
      const tempDir = await makeTempWorkspace("openclaw-workspace-");
      const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
      const existing = "existing agents instructions\n";
      await fs.writeFile(agentsPath, existing, "utf8");

      await withExclusiveCreateError(agentsPath, code, async () => {
        await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
        expect(await fs.readFile(agentsPath, "utf8")).toBe(existing);
      });
    },
  );

  it("still fails exclusive bootstrap create when the target exists but the error is not a collision", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const existing = "existing agents instructions\n";
    await fs.writeFile(agentsPath, existing, "utf8");

    await withExclusiveCreateError(agentsPath, "ENOSPC", async () => {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({
        code: "ENOSPC",
      });
      expect(await fs.readFile(agentsPath, "utf8")).toBe(existing);
    });
  });

  it("still fails exclusive bootstrap create when the target is missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);

    await withExclusiveCreateError(agentsPath, "EPERM", async () => {
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({
        code: "EPERM",
      });
      await expect(fs.access(agentsPath)).rejects.toHaveProperty("code", "ENOENT");
    });
  });
});
