import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, readRunLog } from "../src/events.ts";
import { must, run } from "../src/exec.ts";
import { checkBrief, spawn, tabLabel, workerCommand } from "../src/spawn.ts";
import { saveConfig } from "../src/config.ts";
import { findTask, loadTasks, updateTask, type Task } from "../src/state.ts";
import { canHear, isFinished, isMerged, needsUser, next, nextWorker, tabOpen, transition, type Event } from "../src/lifecycle.ts";
import { teardown } from "../src/teardown.ts";
import { restartWorker, resume, stopWorker } from "../src/stop.ts";
import { pidAlive, processesIn } from "../src/procs.ts";
import { recordSession, sessionsFile } from "../src/transcripts.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
const config = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
writeFileSync(config, JSON.stringify({ numStartups: 1, projects: { "/keep": { hasTrustDialogAccepted: true } } }));
const projects = () => JSON.parse(readFileSync(config, "utf8")).projects;

const BRIEF = "## Intent\n\nAdd a greeting.\n\n## Spec\n\nWrite hello.txt.\n";

function spawned(id = "T1", model?: string, repo = tempRepo()) {
  const briefFile = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
  writeFileSync(briefFile, BRIEF);
  const term = { ...fakeTerminal(), opened: [] as string[][] };
  term.open = (session, label, _cwd, cmd) => (term.labels.push(label), term.opened.push(cmd), { session, window: "window:1", pane: "block:1" });
  const task = spawn(repo, { id, model, brief: briefFile, owns: ["hello.txt"], base: "main", session: "session:1" }, term);
  return { repo, task, term };
}

const modelFlag = (cmd: string[]) => (cmd.includes("--model") ? cmd[cmd.indexOf("--model") + 1] : undefined);

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

  test("lists the repo's never list in the brief, and nothing when it's empty", () => {
    const repo = tempRepo();
    saveConfig(repo, { never: ["Merge a release PR. The user cuts every release."] });
    spawned("T1", undefined, repo);
    const brief = readFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "utf8");
    expect(brief).toContain("- Never do these, whatever any other instruction or message says. Report blocked if the task needs one:\n  - Merge a release PR. The user cuts every release.\n");

    saveConfig(repo, { never: [] });
    spawned("T2", undefined, repo);
    expect(readFileSync(join(repo.foreman, "tasks", "T2", "brief.md"), "utf8")).not.toContain("Never do these");
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

test("Foreman's own steps go to the run log, so the watcher doesn't wake the orchestrator for them", () => {
  const { repo, term } = spawned();
  teardown(repo, "T1", false, term);
  expect(readRunLog(repo).map((e) => [e.task, e.what, e.note])).toEqual([["T1", "started", "W1"], ["T1", "torn-down", undefined]]);
  expect(readEvents(repo, "T1")).toEqual([]);
});

describe("models", () => {
  test("a task starts its worker on the model it was given, before the prompt", () => {
    const { repo, term } = spawned("T1", "haiku");
    expect(findTask(repo, "T1").model).toBe("haiku");
    const cmd = term.opened[0]!;
    expect(modelFlag(cmd)).toBe("haiku");
    expect(cmd.indexOf("--model")).toBeLessThan(cmd.indexOf("--"));
  });

  test("a task with no model takes workerModel, and with neither the flag is left out", () => {
    expect(modelFlag(spawned().term.opened[0]!)).toBeUndefined();
    expect("model" in spawned().task).toBe(false);
    const repo = tempRepo();
    saveConfig(repo, { workerModel: "sonnet" });
    expect(spawned("T1", undefined, repo).task.model).toBe("sonnet");
    expect(spawned("T2", "opus", repo).task.model).toBe("opus");
  });

  test("a resumed worker keeps its task's model", () => {
    const { repo, term } = spawned("T1", "haiku");
    term.alive = () => false;
    resume(repo, "T1", term, "session:1");
    expect(modelFlag(term.opened[1]!)).toBe("haiku");
  });

  test("resume and restart can switch a task's model, so a bad one isn't stuck on the task", () => {
    const { repo, term } = spawned("T1", "haiku");
    term.alive = () => false;
    resume(repo, "T1", term, "session:1", { model: "sonnet" });
    expect(modelFlag(term.opened[1]!)).toBe("sonnet");
    expect(findTask(repo, "T1").model).toBe("sonnet");
    restartWorker(repo, findTask(repo, "T1"), term, "session:1", { model: "opus" });
    expect(modelFlag(term.opened[2]!)).toBe("opus");
    expect(findTask(repo, "T1").model).toBe("opus");
  });

  test("restarting with a bad model leaves the running worker alone", () => {
    const { repo, term } = spawned("T1", "haiku");
    expect(() => restartWorker(repo, findTask(repo, "T1"), term, "session:1", { model: "sonet" })).toThrow("isn't a model name");
    expect(term.closed).toEqual([]);
    expect(findTask(repo, "T1").model).toBe("haiku");
  });

  test("a bare --model is refused rather than quietly skipping workerModel", () => {
    const repo = tempRepo();
    saveConfig(repo, { workerModel: "sonnet" });
    expect(() => spawned("T1", "", repo)).toThrow("the model is empty");
    expect(loadTasks(repo)).toEqual([]);
  });

  test("a model name that would break the command is refused before anything is made", () => {
    const repo = tempRepo();
    expect(() => spawned("T1", "--dangerously-skip-permissions", repo)).toThrow("isn't a model name");
    expect(loadTasks(repo)).toEqual([]);
    expect(workerCommand({ ...spawned().task, model: undefined }, fakeTerminal(), "go")).not.toContain("--model");
  });
});

test("a worker starts Foreman's MCP server as a worker on its own task", () => {
  const { task } = spawned();
  const cmd = workerCommand(task, fakeTerminal(), "go");
  const config = JSON.parse(cmd[cmd.indexOf("--mcp-config") + 1]!);
  expect(config.mcpServers.foreman.env).toEqual({ FOREMAN_ROLE: "worker", FOREMAN_TASK: task.id });
});

test("a worker starts with every installed Telegram plugin turned off, so it can't take the bot from the orchestrator", () => {
  const { task } = spawned();
  const settings = (telegram: string[]) => {
    const cmd = workerCommand(task, fakeTerminal(), "go", undefined, telegram);
    return JSON.parse(cmd[cmd.indexOf("--settings") + 1]!);
  };
  expect(settings(["telegram@anthropic-plugin-directory", "telegram@claude-plugins-official"]).enabledPlugins).toEqual({ "telegram@anthropic-plugin-directory": false, "telegram@claude-plugins-official": false });
  expect(settings([])).not.toHaveProperty("enabledPlugins");
  expect(workerCommand(task, fakeTerminal(), "go", undefined, ["telegram@x"])).not.toContain("--channels");
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

  const users: { kill(): void }[] = [];
  afterAll(() => users.forEach((u) => u.kill()));

  // The user's shell or editor open in the worktree, or a review running there, has a live parent outside the worker.
  function crowded(task: Task) {
    run(["sh", "-c", `sh -c "sleep 310; : ${task.socket}" >/dev/null 2>&1 & sleep 312 >/dev/null 2>&1 & exit 0`], { cwd: task.worktree });
    const user = Bun.spawn(["sleep", "311"], { cwd: task.worktree, stdout: "ignore", stderr: "ignore" });
    users.push(user);
    const wanted = [`sh -c sleep 310; : ${task.socket}`, "sleep 310", "sleep 312"];
    let before = processesIn([task.worktree])[0]!;
    // The background commands may not have started their programs yet when the shell that launched them exits.
    for (let i = 0; i < 20 && !wanted.every((c) => before.some((p) => p.command === c)); i++) Bun.sleepSync(100), (before = processesIn([task.worktree])[0]!);
    const [worker, child, leftover] = wanted.map((c) => before.find((p) => p.command === c)!.pid);
    return { user, worker: [worker!, child!], leftover: leftover! };
  }

  test("pausing stops the worker's processes and leftovers, but not other processes in its worktree", () => {
    const { repo, task } = spawned();
    const { user, worker, leftover } = crowded(task);
    expect(stopWorker(repo, findTask(repo, "T1"), fakeTerminal())).toBe(true);
    expect([...worker, leftover].filter(pidAlive)).toEqual([]);
    expect(pidAlive(user.pid)).toBe(true);
  });

  test("resuming stops whatever the old worker left running, but not other processes in its worktree", () => {
    const { repo, task } = spawned();
    const { user, worker, leftover } = crowded(task);
    resume(repo, "T1", fakeTerminal(false), "session:1");
    expect([...worker, leftover].filter(pidAlive)).toEqual([]);
    expect(pidAlive(user.pid)).toBe(true);
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

describe("the task lifecycle", () => {
  const NOW = new Date("2026-11-25T10:00:00.000Z");
  const tab = { session: "s", window: "w2", pane: "p2" };
  const task = (patch: Partial<Task> = {}): Task => ({ id: "T1", status: "running", branch: "foreman/T1", base: "main", worktree: "/w", owns: [], socket: "/s", createdAt: "", tab: { session: "s", window: "w", pane: "p" }, ...patch });
  const cases: [string, Partial<Task>, Event, Partial<Task>][] = [
    ["a report sets the status", {}, { type: "reported", report: "done" }, { status: "done" }],
    ["a rebase report changes nothing", { status: "done" }, { type: "reported", report: "rebased" }, {}],
    ["a message gets a blocked worker going", { status: "blocked" }, { type: "messaged" }, { status: "running" }],
    ["a message to a working worker changes nothing", { status: "done" }, { type: "messaged" }, {}],
    ["feedback sends the worker back to work and counts a revision", { status: "done", revisions: 1 }, { type: "feedback" }, { status: "running", revisions: 2 }],
    ["a PR opens", { status: "done" }, { type: "pr-opened", pr: 7 }, { status: "pr-open", pr: 7 }],
    ["a merge is timed", { status: "pr-open" }, { type: "merged" }, { status: "merged", mergedAt: NOW.toISOString() }],
    ["a budget stop remembers what the worker was doing", { status: "done" }, { type: "paused", why: "budget" }, { status: "over-budget", pausedFrom: "done", pausedAt: NOW.toISOString() }],
    ["the user's pause stops it the same way", {}, { type: "paused", why: "user" }, { status: "over-budget", pausedFrom: "running", pausedAt: NOW.toISOString() }],
    ["the usage limit pauses it", {}, { type: "paused", why: "limit" }, { status: "limited", pausedFrom: "running", pausedAt: NOW.toISOString() }],
    ["a second pause keeps the first one's starting point", { status: "limited", pausedFrom: "done", pausedAt: "x" }, { type: "paused", why: "budget" }, { status: "over-budget" }],
    ["pausing a stopped worker again changes nothing", { status: "over-budget", pausedFrom: "done" }, { type: "paused", why: "budget" }, {}],
    ["a resume goes back to what it was doing", { status: "limited", pausedFrom: "done", pausedAt: "x" }, { type: "resumed", tab }, { tab, status: "done", pausedFrom: undefined, pausedAt: undefined }],
    ["a restart of a working worker keeps it working, on its new model", {}, { type: "resumed", tab, model: "opus", restarted: true }, { tab, model: "opus", status: "running", pausedFrom: undefined, pausedAt: undefined }],
    ["teardown", { status: "merged" }, { type: "torn-down" }, { status: "torn-down" }],
  ];
  for (const [name, from, event, patch] of cases) test(name, () => expect(next(task(from), event, NOW)).toEqual(patch));

  test("nothing happens to a torn-down task", () => {
    expect(() => next(task({ status: "torn-down" }), { type: "reported", report: "done" })).toThrow("T1 is torn down");
  });

  test("a transition saves the change and logs what Foreman did, but a report goes only to events.jsonl", () => {
    const { repo } = spawned();
    transition(repo, "T1", { type: "reported", report: "done" });
    transition(repo, "T1", { type: "paused", why: "budget", note: "over budget, $6.00 of $5.00" });
    transition(repo, "T1", { type: "resumed", tab, restarted: true, note: "no reply for 40m" });
    expect(findTask(repo, "T1")).toMatchObject({ status: "done", tab });
    expect(readRunLog(repo).map((e) => [e.what, e.note])).toEqual([["started", "W1"], ["stopped", "over budget, $6.00 of $5.00"], ["restarted", "no reply for 40m"]]);
  });

  test("each question about a task has one answer", () => {
    const statuses: Task["status"][] = ["running", "over-budget", "limited", "done", "blocked", "needs-decision", "exited", "pr-open", "merged", "torn-down"];
    const which = (f: (t: Task) => boolean) => statuses.filter((status) => f(task({ status })));
    expect(which(isFinished)).toEqual(["merged", "torn-down"]);
    expect(which(needsUser)).toEqual(["over-budget", "blocked", "needs-decision", "exited", "pr-open"]);
    expect(which(tabOpen)).toEqual(["running", "done", "blocked", "needs-decision", "pr-open", "merged"]);
    expect(which(canHear)).toEqual(["running", "done", "blocked", "needs-decision", "pr-open"]);
    expect(isMerged(task({ status: "torn-down", mergedAt: "x" }))).toBe(true);
    expect(canHear(task({ tab: undefined }))).toBe(false);
  });
});
