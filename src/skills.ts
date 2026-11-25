import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { skillLayout, type AdrLayout } from "./adr.ts";
import type { Repo } from "./paths.ts";

export type Skill = { name: string; description: string; body: string; path: string };

export const PR_SKILL = "pull-request";
export const ADR_SKILL = "adr";

export const SKILLS_PLUGIN = "user-skills";

export const skillsDir = (repo: Repo) => join(repo.foreman, "skills");
export const skillsPluginDir = (repo: Repo) => join(repo.foreman, "skills-plugin");

// The XDG spec says to ignore a relative XDG_CONFIG_HOME.
export function globalSkillsDir(env = process.env): string {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(config, "foreman", "skills");
}

// A reviewer can read a skill only inside a folder passed to it with --add-dir.
export function skillFolders(repo: Repo): string[] {
  return [globalSkillsDir(), skillsDir(repo)].filter((dir) => readFolder(dir).length);
}

// Claude Code loads a --plugin-dir's skills folder in any working directory, and linking each skill back to where it lives keeps the user's files out of every worktree a worker commits from.
export function skillsPluginArgs(repo: Repo): string[] {
  const skills = loadSkills(repo);
  if (!skills.length) return [];
  const dir = skillsPluginDir(repo);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: SKILLS_PLUGIN, description: "The user's own skills from .foreman/skills and ~/.config/foreman/skills" }, null, 2) + "\n");
  linkSkills(join(dir, "skills"), new Map(skills.map((s) => [s.name, dirname(s.path)])));
  return ["--plugin-dir", dir];
}

// Before global skills, the whole folder was one link to .foreman/skills, and replacing it would write into the user's skills.
function linkSkills(dir: string, targets: Map<string, string>) {
  if (isLink(dir)) unlinkSync(dir);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (isLink(path) && readlinkSync(path) !== targets.get(name)) unlinkSync(path);
  }
  for (const [name, target] of targets) {
    try {
      symlinkSync(target, join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// A repo skill replaces a global one of the same name.
export function loadSkills(repo: Repo): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of [...readFolder(globalSkillsDir()), ...readFolder(skillsDir(repo))]) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readFolder(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => parseSkill(join(dir, d.name, "SKILL.md"), d.name));
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
