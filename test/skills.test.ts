import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.ts";
import { adrLayout, adrSkill, globalSkillsDir, loadSkills, prSkill, skillFolders, SKILLS_PLUGIN, skillsDir, skillsPluginArgs, skillsPluginDir } from "../src/skills.ts";
import { spawn, workerCommand } from "../src/spawn.ts";
import { orchestratorPlugins } from "../src/up.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

function addSkill(dir: string, folder: string, text: string) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "SKILL.md"), text);
}

// Without this, a skill in the user's real ~/.config/foreman/skills would reach every test.
const savedConfigHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = realpathSync(mkdtempSync(join(tmpdir(), "foreman-config-")));
});
afterEach(() => {
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
});

test("global skills live in $XDG_CONFIG_HOME/foreman/skills, or ~/.config/foreman/skills without it", () => {
  expect(globalSkillsDir({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/foreman/skills");
  expect(globalSkillsDir({})).toBe(join(homedir(), ".config", "foreman", "skills"));
  expect(globalSkillsDir({ XDG_CONFIG_HOME: "" })).toBe(join(homedir(), ".config", "foreman", "skills"));
  expect(globalSkillsDir({ XDG_CONFIG_HOME: "relative" })).toBe(join(homedir(), ".config", "foreman", "skills"));
});

test("there are no skills without a .foreman/skills or global folder", () => {
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

  test("with skills, the plugin links back to each skill instead of copying it", () => {
    const repo = tempRepo();
    addSkill(skillsDir(repo), "pull-request", "---\nname: pull-request\ndescription: Write the PR.\n---\nOne line commits.\n");
    expect(skillsPluginArgs(repo)).toEqual(["--plugin-dir", skillsPluginDir(repo)]);
    expect(skillsPluginArgs(repo)).toEqual(["--plugin-dir", skillsPluginDir(repo)]);
    expect(JSON.parse(readFileSync(join(skillsPluginDir(repo), ".claude-plugin", "plugin.json"), "utf8")).name).toBe(SKILLS_PLUGIN);
    const link = join(skillsPluginDir(repo), "skills", "pull-request");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(skillsDir(repo), "pull-request")));
  });

  test("a skill added or removed reaches the plugin when the next session starts", () => {
    const repo = tempRepo();
    addSkill(skillsDir(repo), "pull-request", "---\ndescription: Write the PR.\n---\nOne line commits.\n");
    addSkill(skillsDir(repo), "review", "---\ndescription: Review code.\n---\nNo TODOs.\n");
    skillsPluginArgs(repo);
    rmSync(join(skillsDir(repo), "review"), { recursive: true });
    addSkill(skillsDir(repo), "adr", "---\ndescription: Records decisions.\n---\nOne per file.\n");
    skillsPluginArgs(repo);
    expect(readdirSync(join(skillsPluginDir(repo), "skills")).sort()).toEqual(["adr", "pull-request"]);
  });

  test("a plugin from before global skills, linked whole to .foreman/skills, is rebuilt without touching the user's skills", () => {
    const repo = tempRepo();
    addSkill(skillsDir(repo), "pull-request", "---\ndescription: Write the PR.\n---\nOne line commits.\n");
    mkdirSync(skillsPluginDir(repo), { recursive: true });
    symlinkSync(join("..", "skills"), join(skillsPluginDir(repo), "skills"));
    skillsPluginArgs(repo);
    expect(lstatSync(join(skillsPluginDir(repo), "skills")).isDirectory()).toBe(true);
    expect(readdirSync(skillsDir(repo))).toEqual(["pull-request"]);
    expect(realpathSync(join(skillsPluginDir(repo), "skills", "pull-request"))).toBe(realpathSync(join(skillsDir(repo), "pull-request")));
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

describe("global skills", () => {
  const pluginDirs = (cmd: string[]) => cmd.flatMap((a, i) => (a === "--plugin-dir" ? [cmd[i + 1]] : []));

  test("a skill in the global folder loads as user-skills:<name> in the orchestrator and every worker", () => {
    const repo = tempRepo();
    addSkill(globalSkillsDir(), "pull-request", "---\ndescription: Write the PR everywhere.\n---\nOne line commits.\n");
    expect(loadSkills(repo).map((s) => s.name)).toEqual(["pull-request"]);
    expect(prSkill(loadSkills(repo))?.description).toBe("Write the PR everywhere.");
    expect(pluginDirs(orchestratorPlugins(repo))).toContain(skillsPluginDir(repo));
    expect(realpathSync(join(skillsPluginDir(repo), "skills", "pull-request"))).toBe(realpathSync(join(globalSkillsDir(), "pull-request")));

    const brief = join(repo.root, "..", `brief-${Date.now()}.md`);
    writeFileSync(brief, "## Intent\n\nx\n\n## Spec\n\ny\n");
    const opened: string[][] = [];
    const term = { ...fakeTerminal(), open: (session: string, _label: string, _cwd: string, cmd: string[]) => (opened.push(cmd), { session, window: "window:1", pane: "block:1" }) };
    const task = spawn(repo, { id: "T1", brief, owns: ["a.txt"], base: "main", session: "session:1", claudeConfig: join(repo.root, "..", "missing.json") }, term);
    expect(pluginDirs(opened[0]!)).toContain(skillsPluginDir(repo));
    expect(pluginDirs(workerCommand(task, term, "go", "session-id", []))).toContain(skillsPluginDir(repo));
    expect(run(["git", "-C", task.worktree, "status", "--porcelain"]).stdout).toBe("");
  });

  test("a repo skill replaces a global skill of the same name, and the rest of both load", () => {
    const repo = tempRepo();
    addSkill(globalSkillsDir(), "adr", "---\ndescription: Global ADRs.\n---\n```markdown\n# ADR-001: Title\n\n## Status\n\nAccepted\n```\n");
    addSkill(globalSkillsDir(), "review", "---\ndescription: Global review.\n---\nNo TODOs.\n");
    addSkill(skillsDir(repo), "adr", "---\ndescription: Repo ADRs.\n---\n```markdown\n# 1. Title\n\nStatus: Accepted\n```\n");
    addSkill(skillsDir(repo), "pull-request", "---\ndescription: Repo PRs.\n---\nOne line commits.\n");

    const skills = loadSkills(repo);
    expect(skills.map((s) => [s.name, s.description])).toEqual([["adr", "Repo ADRs."], ["pull-request", "Repo PRs."], ["review", "Global review."]]);
    expect(adrSkill(skills)?.path).toBe(join(skillsDir(repo), "adr", "SKILL.md"));
    expect(adrLayout(skills)?.title).not.toContain("ADR-");
    expect(adrLayout(skills)?.title).toEndWith("{title}");

    skillsPluginArgs(repo);
    const linked = join(skillsPluginDir(repo), "skills");
    expect(readdirSync(linked).sort()).toEqual(["adr", "pull-request", "review"]);
    expect(realpathSync(join(linked, "adr"))).toBe(realpathSync(join(skillsDir(repo), "adr")));
    expect(realpathSync(join(linked, "review"))).toBe(realpathSync(join(globalSkillsDir(), "review")));
  });

  test("a repo skill added over a global one replaces its link when the next session starts", () => {
    const repo = tempRepo();
    addSkill(globalSkillsDir(), "review", "---\ndescription: Global review.\n---\nNo TODOs.\n");
    skillsPluginArgs(repo);
    addSkill(skillsDir(repo), "review", "---\ndescription: Repo review.\n---\nTests first.\n");
    skillsPluginArgs(repo);
    expect(realpathSync(join(skillsPluginDir(repo), "skills", "review"))).toBe(realpathSync(join(skillsDir(repo), "review")));
  });

  test("a skill folder linked into the global folder, as dotfiles often do, still loads", () => {
    const repo = tempRepo();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "foreman-dotfiles-")));
    addSkill(elsewhere, "review", "---\ndescription: Linked review.\n---\nNo TODOs.\n");
    mkdirSync(globalSkillsDir(), { recursive: true });
    symlinkSync(join(elsewhere, "review"), join(globalSkillsDir(), "review"));
    expect(loadSkills(repo).map((s) => s.description)).toEqual(["Linked review."]);
  });

  test("skillFolders lists only the folders that hold a skill", () => {
    const repo = tempRepo();
    expect(skillFolders(repo)).toEqual([]);
    addSkill(globalSkillsDir(), "review", "---\ndescription: Global review.\n---\nNo TODOs.\n");
    expect(skillFolders(repo)).toEqual([globalSkillsDir()]);
    addSkill(skillsDir(repo), "adr", "---\ndescription: Repo ADRs.\n---\nOne per file.\n");
    expect(skillFolders(repo)).toEqual([globalSkillsDir(), skillsDir(repo)]);
  });
});
