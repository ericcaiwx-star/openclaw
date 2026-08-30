import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Skill } from "../skills/loading/skill-contract.js";

export type CodeModeSkill = {
  name: string;
  description: string;
  location: string;
  source: Pick<Skill, "filePath" | "readContent">;
  reader?: CodeModeSkillReader;
};

export type CodeModeSkillReader = (params: {
  location: string;
  signal?: AbortSignal;
}) => Promise<string>;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readSkillField(block: string, field: "location" | "name"): string | undefined {
  const match = new RegExp(`^[ ]{4}<${field}>(.*)</${field}>$`, "mu").exec(block)?.[1];
  return match === undefined ? undefined : decodeXml(match);
}

/** Resolve a skill-root-relative path. Rejects absolute paths and `.` / `..` segments. */
export function resolveSkillRelativePath(skillFilePath: string, relativePath: string): string {
  const trimmed = relativePath.trim().replaceAll("\\", "/");
  if (
    !trimmed ||
    path.isAbsolute(trimmed) ||
    trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid skill relative path ${JSON.stringify(relativePath)}`);
  }
  const root = path.dirname(path.resolve(skillFilePath));
  const target = path.resolve(root, trimmed);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`skill relative path escapes skill root: ${JSON.stringify(relativePath)}`);
  }
  return target;
}

/** Select Code Mode skills from the exact catalog rendered into this run's prompt. */
export function resolveCodeModeSkills(params: {
  skillsPrompt: string;
  candidates: readonly Skill[];
  reader?: CodeModeSkillReader;
}): CodeModeSkill[] {
  const catalog = /<available_skills>\n([\s\S]*?)\n<\/available_skills>/u.exec(
    params.skillsPrompt,
  )?.[1];
  if (!catalog) {
    return [];
  }
  const candidatesByName = new Map(params.candidates.map((skill) => [skill.name, skill]));
  const result: CodeModeSkill[] = [];
  for (const match of catalog.matchAll(/^[ ]{2}<skill>\n([\s\S]*?)\n[ ]{2}<\/skill>$/gmu)) {
    const block = match[1] ?? "";
    const name = readSkillField(block, "name");
    const location = readSkillField(block, "location");
    const source = name ? candidatesByName.get(name) : undefined;
    if (!name || !location || !source) {
      continue;
    }
    result.push({
      name,
      description: [source.description, source.locationNote].filter(Boolean).join("\n"),
      location,
      source: { filePath: source.filePath, readContent: source.readContent },
      reader: params.reader,
    });
  }
  return result;
}

export async function readCodeModeSkill(
  skill: CodeModeSkill,
  signal?: AbortSignal,
  relativePath?: string,
): Promise<string> {
  const relative = typeof relativePath === "string" ? relativePath.trim() : "";
  if (!relative) {
    if (typeof skill.source.readContent === "string") {
      return skill.source.readContent;
    }
    if (skill.reader) {
      return await skill.reader({ location: skill.location, signal });
    }
    return await readFile(skill.source.filePath, { encoding: "utf8", signal });
  }

  const hostTarget = resolveSkillRelativePath(skill.source.filePath, relative);
  if (skill.reader) {
    const guestRoot = path.posix.dirname(skill.location.replaceAll("\\", "/"));
    const guestTarget = path.posix.join(guestRoot, relative.replaceAll("\\", "/"));
    return await skill.reader({ location: guestTarget, signal });
  }
  return await readFile(hostTarget, { encoding: "utf8", signal });
}
