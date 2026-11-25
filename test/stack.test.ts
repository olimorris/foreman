import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.ts";
import { deliver } from "../src/deliver.ts";
import { must, run } from "../src/exec.ts";
import { parsePlan, readyTasks, stackable } from "../src/plan.ts";
import { roundDir, type Verdict } from "../src/review.ts";
import { spawn } from "../src/spawn.ts";
import { diffBase, findTask, updateTask, type Task } from "../src/state.ts";
import { renderSummary, reviewOrder, type Ready } from "../src/summary.ts";
import { sync, type SyncProbes } from "../src/sync.ts";
import { prPatches, scan } from "../src/watch.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");

const approve: Verdict = { verdict: "approve", summary: "Matches the intent.", issues: [], risk: "low", risk_note: "", decisions_touched: [] };

const PLAN = parsePlan(`# Plan: Tags

## T1: feat: notes carry tags
- Owns: src/types.ts
- Contract: yes

### Intent
Notes have tags.

### Spec
Add tags.

## T2: feat: tag filter
- Owns: src/list.ts
- Depends on: T1

### Intent
Filter by tag.

### Spec
Read ?tag.

## T3: feat: tag colours
- Owns: src/colours.ts
- Depends on: T1, T2

### Intent
Colour tags.

### Spec
Colours.
`);

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, status: "running", branch: `foreman/${id}`, base: "main", worktree: "/w", owns: [`${id}/`], socket: "/s", createdAt: "", ...extra });

describe("readyTasks with stacking", () => {
  const approved = (t: Task) => t.status === "pr-open";

  test("starts a task on its one unmerged dependency once that has an open PR", () => {
    const r = readyTasks(PLAN, [task("T1", { status: "pr-open" })], 3, approved);
    expect(r.start.map((t) => [t.id, t.stackedOn])).toEqual([["T2", "T1"]]);
    expect(r.waiting).toEqual([{ id: "T3", reason: "waits for T1, T2 to merge" }]);
  });

  test("waits while the dependency has no approved PR, or when stacking is off", () => {
    expect(readyTasks(PLAN, [task("T1")], 3, approved).waiting[0]).toEqual({ id: "T2", reason: "waits for T1's PR" });
    expect(readyTasks(PLAN, [task("T1", { status: "pr-open" })], 3).waiting[0]).toEqual({ id: "T2", reason: "waits for T1 to merge" });
  });

  test("never stacks on a task that is itself stacked", () => {
    const tasks = [task("T1", { status: "merged", mergedAt: "now" }), task("T2", { status: "pr-open", stackedOn: "T1" })];
    const plan = parsePlan("# P\n\n## T4: feat: x\n- Owns: x\n- Depends on: T2\n\n### Intent\ni\n\n### Spec\ns\n");
    expect(readyTasks(plan, tasks, 3, approved).waiting).toEqual([{ id: "T4", reason: "waits for T2 to merge" }]);
  });
});

function setup() {
  const repo = tempRepo();
  const term = fakeTerminal();
  const git = (cwd: string, ...args: string[]) => must(["git", "-C", cwd, ...args]).trim();
  const brief = (id: string) => {
    const file = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
    writeFileSync(file, `## Intent\n\nGreet in ${id}.\n\n## Spec\n\nWrite ${id}.txt.\n`);
    return file;
  };
  const commit = (id: string, text = "hi\n") => {
    const wt = findTask(repo, id).worktree;
    writeFileSync(join(wt, `${id}.txt`), text);
    git(wt, "add", ".");
    git(wt, "commit", "-qm", `change ${id}`);
    return git(wt, "rev-parse", "HEAD");
  };
  const approveTask = (id: string, pr: number) => {
    mkdirSync(roundDir(repo, id, 1), { recursive: true });
    writeFileSync(join(roundDir(repo, id, 1), "verdict.json"), JSON.stringify(approve));
    updateTask(repo, id, { reviews: 1, status: "pr-open", pr });
  };
  spawn(repo, { id: "T1", brief: brief("T1"), owns: ["T1.txt"], base: "main", session: "s" }, term);
  const t1 = commit("T1");
  approveTask("T1", 7);
  spawn(repo, { id: "T2", brief: brief("T2"), owns: ["T2.txt"], base: "main", session: "s", stackedOn: "T1" }, term);
  commit("T2");
  const lastMessage = () => readFileSync(term.sent.at(-1)!.match(/read (\S+) and act/)![1]!, "utf8");
  return { repo, term, git, commit, approveTask, t1, lastMessage };
}

const probes = (over: Partial<SyncProbes> = {}): SyncProbes & { edited: string[] } => {
  const edited: string[] = [];
  return { edited, fetch: () => {}, prState: () => undefined, prBase: () => undefined, setPrBase: (n, base) => (edited.push(`#${n} -> ${base}`), true), ...over };
};

describe("a stacked task", () => {
  test("is only offered when its parent's latest review approved, and stackTasks can turn it off", () => {
    const { repo } = setup();
    expect(stackable(repo)!(findTask(repo, "T1"))).toBe(true);
    expect(stackable(repo)!(findTask(repo, "T2"))).toBe(false);
    saveConfig(repo, { stackTasks: false });
    expect(stackable(repo)).toBeUndefined();
  });

  test("starts from its parent's tip and says so in its brief", () => {
    const { repo, t1 } = setup();
    const t2 = findTask(repo, "T2");
    expect(t2).toMatchObject({ stackedOn: "T1", parentSha: t1, startSha: t1 });
    expect(readFileSync(join(repo.foreman, "tasks", "T2", "brief.md"), "utf8")).toContain("- Branch: foreman/T2 (from foreman/T1, which isn't merged yet)");
    expect(diffBase(repo, t2)).toBe("foreman/T1");
  });

  test("delivers a PR packet with only its own change, naming the PR it builds on", () => {
    const { repo, approveTask } = setup();
    approveTask("T2", 8);
    updateTask(repo, "T2", { pr: undefined, status: "done" });
    const md = readFileSync(deliver(repo, "T2", { dryRun: true, title: "feat: greet" }).packet, "utf8");
    expect(md).toContain("This builds on #7 and should merge after it. It targets #7's branch, so the diff shows only this change. Foreman moves it to main once #7 merges.");
    expect(md).toContain("T2.txt");
    expect(md).not.toContain("T1.txt");
  });

  test("is asked once to rebase when its parent gets new commits, and the parent tip it follows updates after it does", () => {
    const { repo, term, git, commit, t1, lastMessage } = setup();
    expect(sync(repo, "main", term, probes()).asked).toEqual([]);
    const t1b = commit("T1", "hello\n");
    expect(sync(repo, "main", term, probes()).asked).toEqual(["T2"]);
    expect(lastMessage()).toContain(`git rebase --onto foreman/T1 ${t1}`);
    expect(sync(repo, "main", term, probes()).asked).toEqual([]);

    git(findTask(repo, "T2").worktree, "rebase", "-q", "--onto", "foreman/T1", t1);
    expect(sync(repo, "main", term, probes()).asked).toEqual([]);
    expect(findTask(repo, "T2").parentSha).toBe(t1b);
  });

  test("moves onto the base and its PR to the base once its parent is squash-merged", () => {
    const { repo, term, git, t1, lastMessage } = setup();
    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    const p = probes({ prState: (n) => (n === 7 ? "MERGED" : "OPEN"), prBase: (n) => (n === 8 ? "foreman/T1" : "main") });
    updateTask(repo, "T2", { pr: 8, status: "pr-open" });
    const r = sync(repo, "main", term, p);
    expect(r).toMatchObject({ merged: ["T1"], asked: ["T2"], retargeted: [] });
    expect(lastMessage()).toContain(`git rebase --onto main ${t1}`);
    expect(findTask(repo, "T2").stackedOn).toBe("T1");
    expect(diffBase(repo, findTask(repo, "T2"))).toBe("foreman/T1");
    expect(sync(repo, "main", term, p)).toMatchObject({ asked: [], retargeted: [] });

    const wt = findTask(repo, "T2").worktree;
    git(wt, "rebase", "-q", "--onto", "main", t1);
    expect(git(wt, "log", "--format=%s", "main..HEAD")).toBe("change T2");
    expect(sync(repo, "main", term, p)).toMatchObject({ asked: [], retargeted: ["T2"] });
    expect(p.edited).toEqual(["#8 -> main"]);
    expect(findTask(repo, "T2").stackedOn).toBeUndefined();
    expect(diffBase(repo, findTask(repo, "T2"))).toBe("main");
  });

  test("a base that moves after its rebase gets a plain rebase, not the --onto one again", () => {
    const { repo, term, git, t1, lastMessage } = setup();
    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    updateTask(repo, "T1", { status: "merged", mergedAt: "now" });
    sync(repo, "main", term, probes());
    git(findTask(repo, "T2").worktree, "rebase", "-q", "--onto", "main", t1);
    git(repo.root, "commit", "-q", "--allow-empty", "-m", "main moves");
    expect(sync(repo, "main", term, probes()).asked).toEqual(["T2"]);
    expect(lastMessage()).toContain("git rebase main");
    expect(findTask(repo, "T2").stackedOn).toBeUndefined();
  });

  test("still gets the --onto rebase when its parent merged and was torn down while its worker was away", () => {
    const { repo, term, git, t1, lastMessage } = setup();
    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    updateTask(repo, "T2", { status: "exited" });
    expect(sync(repo, "main", term, probes({ prState: (n) => (n === 7 ? "MERGED" : undefined) }))).toMatchObject({ merged: ["T1"], asked: [] });
    git(repo.root, "worktree", "remove", "--force", findTask(repo, "T1").worktree);
    git(repo.root, "branch", "-D", "foreman/T1");
    updateTask(repo, "T1", { status: "torn-down" });

    updateTask(repo, "T2", { status: "running" });
    expect(sync(repo, "main", term, probes()).asked).toEqual(["T2"]);
    expect(lastMessage()).toContain(`git rebase --onto main ${t1}`);
    expect(diffBase(repo, findTask(repo, "T2"))).toBe(t1);
  });

  test("leaves its PR alone when GitHub already moved it to the base", () => {
    const { repo, term, git } = setup();
    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    updateTask(repo, "T1", { status: "merged", mergedAt: "now" });
    updateTask(repo, "T2", { pr: 8 });
    const p = probes({ prBase: () => "main" });
    expect(sync(repo, "main", term, p)).toMatchObject({ asked: ["T2"], retargeted: [] });
    const t2 = findTask(repo, "T2");
    must(["git", "-C", t2.worktree, "rebase", "-q", "--onto", "main", t2.parentSha!]);
    expect(sync(repo, "main", term, p)).toMatchObject({ asked: [], retargeted: [] });
    expect(findTask(repo, "T2").stackedOn).toBeUndefined();
    expect(p.edited).toEqual([]);
  });

  test("carries its parent's commits onto the base when the user dropped the parent and kept it", () => {
    const { repo, term, git, lastMessage } = setup();
    git(repo.root, "commit", "-q", "--allow-empty", "-m", "main moves");
    updateTask(repo, "T1", { status: "torn-down" });
    expect(sync(repo, "main", term, probes()).asked).toEqual(["T2"]);
    expect(lastMessage()).toContain("git rebase main");
    expect(findTask(repo, "T2").stackedOn).toBeUndefined();
  });
});

describe("a PR that didn't reach the base", () => {
  test("a closed PR is recorded, and no new task stacks on it", () => {
    const { repo, term } = setup();
    expect(sync(repo, "main", term, probes({ prState: (n) => (n === 7 ? "CLOSED" : undefined) })).merged).toEqual([]);
    expect(findTask(repo, "T1").prClosed).toBe(true);
    expect(stackable(repo)!(findTask(repo, "T1"))).toBe(false);
    sync(repo, "main", term, probes({ prState: (n) => (n === 7 ? "OPEN" : undefined) }));
    expect(findTask(repo, "T1").prClosed).toBeUndefined();
  });

  test("a stacked PR merged into its parent's branch isn't counted as merged until that branch merges", () => {
    const { repo, term, git } = setup();
    updateTask(repo, "T2", { pr: 8, status: "pr-open" });
    const early = probes({ prState: (n) => (n === 8 ? "MERGED" : "OPEN"), prBase: (n) => (n === 8 ? "foreman/T1" : "main") });
    expect(sync(repo, "main", term, early)).toMatchObject({ merged: [], mergedEarly: ["T2"] });
    expect(findTask(repo, "T2")).toMatchObject({ mergedInto: "foreman/T1", status: "pr-open" });
    expect(stackable(repo)!(findTask(repo, "T2"))).toBe(false);

    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    const r = sync(repo, "main", term, probes({ prState: () => "MERGED", prBase: (n) => (n === 8 ? "foreman/T1" : "main") }));
    expect(r).toMatchObject({ merged: ["T1", "T2"], asked: [] });
  });

  test("the watcher records closed and early-merged PRs on their tasks", () => {
    const tasks = [task("T1", { pr: 7 }), task("T2", { pr: 8, stackedOn: "T1" })];
    const prs = [{ key: "T1", number: 7, base: "main" }, { key: "T2", number: 8, base: "main" }];
    expect(prPatches(tasks, prs, { "7": { state: "CLOSED", comments: 0 }, "8": { state: "MERGED", comments: 0, base: "foreman/T1" } }))
      .toEqual([["T1", { prClosed: true }], ["T2", { mergedInto: "foreman/T1" }]]);
    expect(prPatches(tasks, prs, { "8": { state: "MERGED", comments: 0, base: "main" } })).toEqual([]);
  });

  test("the watcher reports a stacked PR merged into its parent's branch on its own line", () => {
    const p = (state: string) => ({ events: () => [], mainSha: () => "aaa", alive: () => true, pr: () => ({ state, comments: 0, base: "foreman/T1" }) });
    const prs = [{ key: "T2", number: 8, base: "main" }];
    const first = scan([], { events: {}, exited: [], main: "aaa" }, p("OPEN"), prs);
    expect(scan([], first.cursor, p("MERGED"), prs).reasons).toEqual(["merged-early T2 #8 into foreman/T1"]);
  });
});

test("the watcher's closed line names the tasks stacked on that PR", () => {
  const tasks = [task("T1", { pr: 7, status: "pr-open" }), task("T2", { stackedOn: "T1" }), task("T3", { stackedOn: "T1" })];
  const p = (state: string) => ({ events: () => [], mainSha: () => "aaa", alive: () => true, pr: () => ({ state, comments: 0 }) });
  const first = scan(tasks, { events: {}, exited: [], main: "aaa" }, p("OPEN"), [{ key: "T1", number: 7 }]);
  expect(scan(tasks, first.cursor, p("CLOSED"), [{ key: "T1", number: 7 }]).reasons).toEqual(["closed T1 #7, which T2 and T3 build on"]);
});

describe("the run summary", () => {
  const ready = (id: string, pr: number, risk: Verdict["risk"], extra: Partial<Task> = {}, blocks: string[] = []): Ready =>
    ({ task: task(id, { status: "pr-open", pr, ...extra }), title: `feat: ${id}`, verdict: { ...approve, risk }, blocks });

  test("lists a stacked PR after the one it builds on, and says so", () => {
    const items = [ready("T2", 8, "high", { stackedOn: "T1" }, ["T3"]), ready("T1", 7, "low"), ready("T4", 9, "medium")];
    expect(reviewOrder(items).map((r) => r.task.id)).toEqual(["T1", "T2", "T4"]);
    const md = renderSummary({ title: "Tags", ready: items, merged: [], unfinished: [], calls: [], cut: [], open: [], spent: 0 });
    expect(md).toContain("2. **#8 feat: T2** (T2) - builds on #7 (T1), so merge it after that");
  });
});
