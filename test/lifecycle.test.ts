import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "../src/events.ts";
import { must, run } from "../src/exec.ts";
import { checkBrief, spawn, tabLabel } from "../src/spawn.ts";
import { findTask, loadTasks, nextWorker, updateTask, type Task } from "../src/state.ts";
import { teardown } from "../src/teardown.ts";
import { resume, stopWorker } from "../src/stop.ts";
import { recordSession, sessionsFile } from "../src/cost.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
const config = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
writeFileSync(config, JSON.stringify({ numStartups: 1, projects: { "/keep": { hasTrustDialogAccepted: true } } }));
const projects = () => JSON.parse(readFileSync(config, "utf8")).projects;

const BRIEF = "## Intent\n\nAdd a greeting.\n\n## Spec\n\nWrite hello.txt.\n";

function spawned(id = "T1") {
  const repo = tempRepo();
  const briefFile = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
  writeFileSync(briefFile, BRIEF);
  const term = fakeTerminal();
  const task = spawn(repo, { id, brief: briefFile, owns: ["hello.txt"], base: "main", session: "session:1" }, term);
  return { repo, task, term };
}

describe("spawn", () => {
  test("creates the worktree, branch, brief and task record", () => {
    const { repo, task } = spawned();
    expect(existsSync(join(task.worktree, "README.md"))).toBe(true);
    expect(run(["git", "-C", task.worktree, "branch", "--show-current"]).stdout.trim()).toBe("foreman/T1");
    expect(readFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "utf8")).toContain("Owned paths: `hello.txt`");
    expect(findTask(repo, "T1").tab).toEqual({ session: "session:1", window: "window:1", pane: "block:1" });
    expect(readFileSync(join(repo.root, ".git", "info", "exclude"), "utf8")).toContain(".foreman/");
    expect(projects()[task.worktree]).toEqual({ hasTrustDialogAccepted: true });
    expect(projects()["/keep"]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("labels the tab with the id and the start of the title", () => {
    const { term } = spawned();
    expect(term.labels).toEqual(["W1 · T1"]);
    expect(tabLabel({ id: "T2", title: "feat(settings)!: add an export button to the settings pane" })).toBe("T2: add an export button");
    expect(tabLabel({ id: "T3", title: "fix: crash", worker: "W2" })).toBe("W2 · T3: crash");
  });

  test("refuses a title that isn't a conventional commit", () => {
    const { repo, term } = spawned();
    expect(() => spawn(repo, { id: "T2", title: "add tags", brief: "/dev/null", owns: ["x"], base: "main", session: "s" }, term)).toThrow("conventional commit");
  });

  test("refuses a duplicate id or a brief without intent and spec", () => {
    const { repo, term } = spawned();
    expect(() => spawn(repo, { id: "T1", brief: "/dev/null", owns: ["x"], base: "main", session: "s" }, term)).toThrow("already exists");
    expect(() => checkBrief("## Spec\n")).toThrow("## Intent");
  });
});

test("events append and read back in order", () => {
  const { repo } = spawned();
  appendEvent(repo, "T1", "blocked", "need the API shape");
  appendEvent(repo, "T1", "done", "greeting added");
  expect(readEvents(repo, "T1").map((e) => e.type)).toEqual(["blocked", "done"]);
});

test("tasks saved with a Rex tab load with it as their tab", () => {
  const { repo } = spawned();
  const path = join(repo.foreman, "tasks.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.tasks[0] = { ...saved.tasks[0], tab: undefined, rex: { session: "s", window: "w", block: "b" } };
  writeFileSync(path, JSON.stringify(saved));
  expect(findTask(repo, "T1").tab).toEqual({ session: "s", window: "w", pane: "b" });
});

test("each new worker takes the lowest number no running task holds", () => {
  const t = (worker: string, status: Task["status"] = "running") => ({ id: worker, worker, status }) as Task;
  expect(nextWorker([])).toBe("W1");
  expect(nextWorker([t("W1"), t("W3")])).toBe("W2");
  expect(nextWorker([t("W1", "torn-down"), t("W2", "merged"), t("W3", "pr-open")])).toBe("W1");
});

describe("stop and resume", () => {
  test("stopping closes the worker's tab and resuming reopens its last session", () => {
    const { repo } = spawned();
    const term = { ...fakeTerminal(), opened: [] as string[][] };
    term.open = (session, _label, _cwd, cmd) => (term.opened.push(cmd), { session, window: "window:2", pane: "block:2" });
    updateTask(repo, "T1", { status: "done" });
    expect(stopWorker(repo, findTask(repo, "T1"), term)).toBe(true);
    expect(term.closed).toEqual(["window:1"]);
    expect(findTask(repo, "T1").status).toBe("over-budget");

    expect(() => resume(repo, "T1", term, "session:1")).toThrow("still running");
    term.alive = () => false;
    recordSession(sessionsFile(repo, "T1"), "sess-1");
    resume(repo, "T1", term, "session:1");
    expect(term.opened[0]).toContain("sess-1");
    expect(findTask(repo, "T1")).toMatchObject({ status: "done", tab: { window: "window:2" } });
    expect(findTask(repo, "T1").pausedFrom).toBeUndefined();
  });

  test("stopping a worker whose tab is already closed changes nothing", () => {
    const { repo } = spawned();
    expect(stopWorker(repo, findTask(repo, "T1"), fakeTerminal(false))).toBe(false);
    expect(findTask(repo, "T1").status).toBe("running");
  });
});

describe("teardown", () => {
  test("refuses while the branch has unmerged commits, and removes nothing", () => {
    const { repo, task, term } = spawned();
    writeFileSync(join(task.worktree, "hello.txt"), "hi\n");
    must(["git", "-C", task.worktree, "add", "."]);
    must(["git", "-C", task.worktree, "commit", "-qm", "hello"]);
    const r = teardown(repo, "T1", false, term);
    expect(r.removed).toBe(false);
    expect(r.message).toContain("1 unmerged commit");
    expect(existsSync(task.worktree)).toBe(true);
    expect(term.closed).toEqual([]);
  });

  test("refuses with uncommitted files even when nothing is committed", () => {
    const { repo, task, term } = spawned();
    writeFileSync(join(task.worktree, "hello.txt"), "hi\n");
    expect(teardown(repo, "T1", false, term).message).toContain("1 uncommitted file");
  });

  test("keeps uncommitted files even when the task is marked merged", () => {
    const { repo, task, term } = spawned();
    updateTask(repo, "T1", { mergedAt: "2026-11-25T08:33:52.150Z", status: "merged" });
    writeFileSync(join(task.worktree, "hello.txt"), "hi\n");
    const r = teardown(repo, "T1", false, term);
    expect(r.message).toContain("1 uncommitted file");
    expect(term.closed).toEqual([]);
  });

  test("removes everything once the branch is merged", () => {
    const { repo, task, term } = spawned();
    writeFileSync(join(task.worktree, "hello.txt"), "hi\n");
    must(["git", "-C", task.worktree, "add", "."]);
    must(["git", "-C", task.worktree, "commit", "-qm", "hello"]);
    must(["git", "-C", repo.root, "merge", "-q", "--ff-only", "foreman/T1"]);
    const r = teardown(repo, "T1", false, term);
    expect(r.removed).toBe(true);
    expect(existsSync(task.worktree)).toBe(false);
    expect(run(["git", "-C", repo.root, "rev-parse", "--verify", "foreman/T1"]).code).not.toBe(0);
    expect(term.closed).toEqual(["window:1"]);
    expect(findTask(repo, "T1").status).toBe("torn-down");
    expect(projects()[task.worktree]).toBeUndefined();
  });

  test("--discard removes unmerged work", () => {
    const { repo, task, term } = spawned();
    writeFileSync(join(task.worktree, "hello.txt"), "hi\n");
    expect(teardown(repo, "T1", true, term).removed).toBe(true);
    expect(existsSync(task.worktree)).toBe(false);
  });
});

test("concurrent task updates don't lose writes", async () => {
  const { repo } = spawned();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", "-e", `
        const { withTasks } = await import("${join(import.meta.dir, "..", "src", "state.ts")}");
        const repo = ${JSON.stringify(repo)};
        withTasks(repo, (tasks) => tasks[0].owns.push("f${i}"));
      `]).exited,
    ),
  );
  expect(loadTasks(repo)[0]!.owns.length).toBe(9);
  updateTask(repo, "T1", { status: "done" });
  expect(findTask(repo, "T1").status).toBe("done");
});
