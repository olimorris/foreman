import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skillLayout, type AdrLayout } from "./adr.ts";
import type { Repo } from "./paths.ts";

export type Skill = { name: string; description: string; body: string; path: string };

export const PR_SKILL = "pull-request";
export const ADR_SKILL = "adr";

export const SKILLS_PLUGIN = "user-skills";

export const skillsDir = (repo: Repo) => join(repo.foreman, "skills");
export const skillsPluginDir = (repo: Repo) => join(repo.foreman, "skills-plugin");

// Claude Code loads a --plugin-dir's skills folder in any working directory, and the link back to .foreman/skills keeps the user's files out of every worktree a worker commits from.
export function skillsPluginArgs(repo: Repo): string[] {
  if (!loadSkills(repo).length) return [];
  const dir = skillsPluginDir(repo);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: SKILLS_PLUGIN, description: "The user's own skills from .foreman/skills" }, null, 2) + "\n");
  const link = join(dir, "skills");
  if (!existsSync(link) && !isLink(link)) symlinkSync(join("..", "skills"), link);
  return ["--plugin-dir", dir];
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadSkills(repo: Repo): Skill[] {
  const dir = skillsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => parseSkill(join(dir, d.name, "SKILL.md"), d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const prSkill = (skills: Skill[]) => skills.find((s) => s.name === PR_SKILL);
export const adrSkill = (skills: Skill[]) => skills.find((s) => s.name === ADR_SKILL);

export function adrLayout(skills: Skill[]): AdrLayout | undefined {
  const skill = adrSkill(skills);
  return skill && skillLayout(skill.body);
}

// Claude Code's skill format, named by its folder because a copied skill keeps its original frontmatter name.
export function parseSkill(path: string, folder: string): Skill {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fields: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { name: folder, description: fields.description ?? "", body: (m ? m[2]! : text).trim(), path };
}
