import path from "node:path";
import { root as createFsSafeRoot } from "../../infra/fs-safe.js";

export const SKILL_COMPANION_MAX_BYTES = 256_000;

/** Final source-host owner for one selected skill companion read. */
export async function readSkillCompanionAtSource(params: {
  skillFilePath: string;
  relativePath: string;
  signal?: AbortSignal;
}): Promise<string> {
  params.signal?.throwIfAborted();
  if (path.basename(params.skillFilePath).toLowerCase() !== "skill.md") {
    throw new Error("Skill companion root must be selected by its SKILL.md path");
  }
  const root = await createFsSafeRoot(path.dirname(path.resolve(params.skillFilePath)));
  params.signal?.throwIfAborted();
  const result = await root.read(params.relativePath, {
    hardlinks: "reject",
    maxBytes: SKILL_COMPANION_MAX_BYTES,
    symlinks: "reject",
  });
  params.signal?.throwIfAborted();
  return result.buffer.toString("utf8");
}
