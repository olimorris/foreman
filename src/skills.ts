import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";

export type Skill = { name: string; description: string; body: string; path: string };

export const PR_SKILL = "pull-request";

export const skillsDir = (repo: Repo) => join(repo.foreman, "skills");

export function loadSkills(repo: Repo): Skill[] {
  const dir = skillsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => parseSkill(join(dir, d.name, "SKILL.md"), d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const prSkill = (skills: Skill[]) => skills.find((s) => s.name === PR_SKILL);

// Claude Code's skill format: YAML frontmatter with name and description, then the Markdown body.
export function parseSkill(path: string, folder: string): Skill {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fields: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { name: fields.name || folder, description: fields.description ?? "", body: (m ? m[2]! : text).trim(), path };
}
