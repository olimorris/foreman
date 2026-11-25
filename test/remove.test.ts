import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must, run } from "../src/exec.ts";
import { spawn } from "../src/spawn.ts";
import { updateTask } from "../src/state.ts";
import { removeForeman } from "../src/remove.ts";
import type { Repo } from "../src/paths.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
const config = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
writeFileSync(config, JSON.stringify({ projects: { "/keep": { hasTrustDialogAccepted: true } } }));
const projects = () => JSON.parse(readFileSync(config, "utf8")).projects;

function withTasks(...ids: string[]) {
  const repo = tempRepo();
  const term = fakeTerminal();
  const brief = join(repo.root, "..", `brief-${Date.now()}.md`);
  writeFileSync(brief, "## Intent\n\nAdd a greeting.\n\n## Spec\n\nWrite hello.txt.\n");
  const tasks = ids.map((id) => spawn(repo, { id, brief, owns: [`${id}.txt`], base: "main", session: "session:1" }, term));
  return { repo, term, tasks };
}

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), "hi\n");
  must(["git", "-C", dir, "add", "."]);
  must(["git", "-C", dir, "commit", "-qm", file]);
}

const foremanBranches = (repo: Repo) => run(["git", "-C", repo.root, "branch", "--list", "foreman/*"]).stdout.trim();
const worktrees = (repo: Repo) => run(["git", "-C", repo.root, "worktree", "list", "--porcelain"]).stdout.split("\n").filter((l) => l.startsWith("worktree "));
const exclude = (repo: Repo) => readFileSync(join(repo.root, ".git", "info", "exclude"), "utf8");

test("leaves no .foreman/, foreman/* branches, Foreman worktrees or exclude line", () => {
  const { repo, term, tasks } = withTasks("T1", "T2");
  commit(tasks[0]!.worktree, "T1.txt");
  must(["git", "-C", repo.root, "merge", "-q", "--ff-only", "foreman/T1"]);
  expect(exclude(repo)).toContain(".foreman/");

  const r = removeForeman(repo, false, term, { cwd: repo.root });
  expect(r.removed).toBe(true);
  expect(existsSync(repo.foreman)).toBe(false);
  expect(foremanBranches(repo)).toBe("");
  expect(worktrees(repo)).toEqual([`worktree ${repo.root}`]);
  expect(exclude(repo).split("\n")).not.toContain(".foreman/");
  expect(term.closed).toEqual(["window:1", "window:1"]);
  expect(projects()[tasks[0]!.worktree]).toBeUndefined();
  expect(projects()["/keep"]).toEqual({ hasTrustDialogAccepted: true });
  expect(r.message).toContain("2 worktrees");
  expect(r.message).toContain("foreman/T1, foreman/T2");
  expect(r.message).toContain("Branches Foreman pushed and its PRs are still on GitHub");
});

test("keeps the user's own lines in .git/info/exclude", () => {
  const { repo, term } = withTasks("T1");
  writeFileSync(join(repo.root, ".git", "info", "exclude"), "# mine\n.foreman/\n*.log\n");
  removeForeman(repo, false, term, { cwd: repo.root });
  expect(exclude(repo)).toBe("# mine\n*.log\n");
});

test("refuses with unmerged work, names those tasks and removes nothing", () => {
  const { repo, term, tasks } = withTasks("T1", "T2", "T3");
  commit(tasks[0]!.worktree, "T1.txt");
  writeFileSync(join(tasks[1]!.worktree, "T2.txt"), "draft\n");

  const r = removeForeman(repo, false, term, { cwd: repo.root });
  expect(r.removed).toBe(false);
  expect(r.message).toContain("- T1: 1 unmerged commit and 0 uncommitted files");
  expect(r.message).toContain("- T2: 0 unmerged commits and 1 uncommitted file");
  expect(r.message).not.toContain("T3");
  expect(r.message).toContain("foreman remove --discard");
  expect(existsSync(tasks[0]!.worktree)).toBe(true);
  expect(foremanBranches(repo)).toContain("foreman/T1");
  expect(exclude(repo)).toContain(".foreman/");
  expect(term.closed).toEqual([]);
});

test("counts uncommitted files in a task marked merged", () => {
  const { repo, term, tasks } = withTasks("T1");
  updateTask(repo, "T1", { mergedAt: "2026-11-25T08:33:52.150Z", status: "merged" });
  writeFileSync(join(tasks[0]!.worktree, "T1.txt"), "draft\n");
  expect(removeForeman(repo, false, term, { cwd: repo.root }).message).toContain("- T1: 0 unmerged commits and 1 uncommitted file");
});

test("--discard removes unmerged work and says whose it was", () => {
  const { repo, term, tasks } = withTasks("T1");
  commit(tasks[0]!.worktree, "T1.txt");
  writeFileSync(join(tasks[0]!.worktree, "more.txt"), "draft\n");

  const r = removeForeman(repo, true, term, { cwd: repo.root });
  expect(r.removed).toBe(true);
  expect(r.message).toContain("Discarded the unmerged work in T1.");
  expect(existsSync(repo.foreman)).toBe(false);
  expect(foremanBranches(repo)).toBe("");
});

test("refuses while the orchestrator is running for the repo", () => {
  const { repo, tasks } = withTasks("T1");
  const term = { ...fakeTerminal(), findSession: (name: string) => (name === `foreman-${repo.root.split("/").at(-1)}` ? "session:9" : undefined) };
  const r = removeForeman(repo, true, term, { cwd: repo.root });
  expect(r.removed).toBe(false);
  expect(r.message).toContain("The orchestrator is still running");
  expect(existsSync(tasks[0]!.worktree)).toBe(true);
});

test("refuses from inside a Foreman worktree", () => {
  const { repo, term, tasks } = withTasks("T1");
  const r = removeForeman(repo, true, term, { cwd: tasks[0]!.worktree });
  expect(r.removed).toBe(false);
  expect(r.message).toContain(`Run foreman remove from ${repo.root}`);
  expect(existsSync(tasks[0]!.worktree)).toBe(true);
});

test("clears a worktree and branch left behind without a task record", () => {
  const repo = tempRepo();
  must(["git", "-C", repo.root, "worktree", "add", "-q", "-b", "foreman/old", join(repo.foreman, "worktrees", "old")]);
  const r = removeForeman(repo, false, fakeTerminal(), { cwd: repo.root });
  expect(r.removed).toBe(true);
  expect(worktrees(repo)).toEqual([`worktree ${repo.root}`]);
  expect(foremanBranches(repo)).toBe("");
});
