import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/exec.ts";
import { adrLayout, adrSkill, loadSkills, prSkill, SKILLS_PLUGIN, skillsDir, skillsPluginArgs, skillsPluginDir } from "../src/skills.ts";
import { spawn, workerCommand } from "../src/spawn.ts";
import { orchestratorPlugins } from "../src/up.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

function addSkill(dir: string, folder: string, text: string) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "SKILL.md"), text);
}

test("there are no skills without a .foreman/skills folder", () => {
  expect(loadSkills(tempRepo())).toEqual([]);
});

test("loadSkills reads each folder's SKILL.md in Claude Code's format", () => {
  const repo = tempRepo();
  const dir = skillsDir(repo);
  addSkill(dir, "pull-request", "---\nname: pull-request\ndescription: \"Write the PR. Use when opening a PR.\"\n---\n\n# PRs\n\nOne line commits.\n");
  addSkill(dir, "review", "---\ndescription: Review code for this repo.\n---\nNo TODOs.\n");
  addSkill(dir, "plain", "Just a body.\n");
  mkdirSync(join(dir, "empty"), { recursive: true });

  const skills = loadSkills(repo);
  expect(skills.map((s) => s.name)).toEqual(["plain", "pull-request", "review"]);
  expect(skills[1]).toEqual({ name: "pull-request", description: "Write the PR. Use when opening a PR.", body: "# PRs\n\nOne line commits.", path: join(dir, "pull-request", "SKILL.md") });
  expect(skills[2]).toMatchObject({ name: "review", description: "Review code for this repo.", body: "No TODOs." });
  expect(skills[0]).toMatchObject({ description: "", body: "Just a body." });
  expect(prSkill(skills)?.name).toBe("pull-request");
  expect(prSkill(skills.filter((s) => s.name !== "pull-request"))).toBeUndefined();
});

test("a skill is named by its folder, so a copied ADR skill becomes the adr skill", () => {
  const repo = tempRepo();
  addSkill(skillsDir(repo), "adr", "---\nname: documentation-and-adrs\ndescription: Records decisions.\n---\n\n```markdown\n# ADR-001: Title\n\n## Status\n\nAccepted\n```\n");
  const skills = loadSkills(repo);
  expect(adrSkill(skills)?.name).toBe("adr");
  expect(adrLayout(skills)).toMatchObject({ title: "# ADR-{N}: {title}", status: { kind: "section" } });
  expect(adrLayout([])).toBeUndefined();
});

describe("the skills plugin", () => {
  const pluginDirs = (cmd: string[]) => cmd.flatMap((a, i) => (a === "--plugin-dir" ? [cmd[i + 1]] : []));

  test("without skills, sessions start with no skills plugin and nothing is written", () => {
    const repo = tempRepo();
    expect(skillsPluginArgs(repo)).toEqual([]);
    mkdirSync(skillsDir(repo), { recursive: true });
    expect(skillsPluginArgs(repo)).toEqual([]);
    expect(existsSync(skillsPluginDir(repo))).toBe(false);
  });

  test("with skills, the plugin links back to .foreman/skills instead of copying them", () => {
    const repo = tempRepo();
    addSkill(skillsDir(repo), "pull-request", "---\nname: pull-request\ndescription: Write the PR.\n---\nOne line commits.\n");
    expect(skillsPluginArgs(repo)).toEqual(["--plugin-dir", skillsPluginDir(repo)]);
    expect(skillsPluginArgs(repo)).toEqual(["--plugin-dir", skillsPluginDir(repo)]);
    expect(JSON.parse(readFileSync(join(skillsPluginDir(repo), ".claude-plugin", "plugin.json"), "utf8")).name).toBe(SKILLS_PLUGIN);
    expect(lstatSync(join(skillsPluginDir(repo), "skills")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(skillsPluginDir(repo), "skills"))).toBe(realpathSync(skillsDir(repo)));
    addSkill(skillsDir(repo), "review", "---\ndescription: Review code.\n---\nNo TODOs.\n");
    expect(readdirSync(join(skillsPluginDir(repo), "skills")).sort()).toEqual(["pull-request", "review"]);
  });

  test("the orchestrator and every worker load the skills plugin, and the worktree gets no copy", () => {
    const repo = tempRepo();
    addSkill(skillsDir(repo), "pull-request", "---\ndescription: Write the PR.\n---\nOne line commits.\n");
    expect(pluginDirs(orchestratorPlugins(repo))).toContain(skillsPluginDir(repo));

    const brief = join(repo.root, "..", `brief-${Date.now()}.md`);
    writeFileSync(brief, "## Intent\n\nx\n\n## Spec\n\ny\n");
    const opened: string[][] = [];
    const term = { ...fakeTerminal(), open: (session: string, _label: string, _cwd: string, cmd: string[]) => (opened.push(cmd), { session, window: "window:1", pane: "block:1" }) };
    const task = spawn(repo, { id: "T1", brief, owns: ["a.txt"], base: "main", session: "session:1", claudeConfig: join(repo.root, "..", "missing.json") }, term);
    expect(pluginDirs(opened[0]!)).toContain(skillsPluginDir(repo));
    expect(pluginDirs(workerCommand(task, term, "go", "session-id", []))).toContain(skillsPluginDir(repo));
    expect(existsSync(join(task.worktree, ".foreman"))).toBe(false);
    expect(run(["git", "-C", task.worktree, "status", "--porcelain"]).stdout).toBe("");
  });
});
