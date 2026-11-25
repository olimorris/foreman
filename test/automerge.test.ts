import { describe, expect, test } from "bun:test";
import { automerge, automergeOn, checksOf, mergeMethod, type Check } from "../src/automerge.ts";
import { saveConfig } from "../src/config.ts";
import { UsageError } from "../src/help.ts";
import { loadPlan, parsePlan, savePlan } from "../src/plan.ts";
import { withTasks, type Task } from "../src/state.ts";
import { scan, type Cursor, type PrState, type Probes, type TrackedPr } from "../src/watch.ts";
import { tempRepo } from "./helpers.ts";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, status: "pr-open", branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: ["src/"], socket: "", pr: 41, createdAt: "", ...extra,
});

const pass = (name = "test"): Check => ({ name, state: "pass" });
const open = (extra: Partial<PrState> = {}): PrState => ({ state: "OPEN", comments: 0, base: "main", head: "foreman/T1", sha: "abc", checks: [pass()], ...extra });

const tracked: TrackedPr[] = [{ key: "T1", number: 41, base: "main" }];
const start: Cursor = { events: {}, exited: [], main: "aaa" };

function probes(pr: PrState, opts: { on?: boolean; approved?: boolean } = {}): Probes {
  return { events: () => [], mainSha: () => "aaa", alive: () => true, pr: () => pr, automerge: () => opts.on ?? true, approved: () => opts.approved ?? true };
}

describe("merging approved PRs", () => {
  test("an approved PR with green checks merges at its head", () => {
    expect(scan([task("T1")], start, probes(open()), tracked).merge).toEqual([{ id: "T1", number: 41, sha: "abc" }]);
  });

  test("a PR with no checks merges once approved", () => {
    expect(scan([task("T1")], start, probes(open({ checks: [] })), tracked).merge).toHaveLength(1);
  });

  test("pending checks wait without waking the orchestrator", () => {
    const r = scan([task("T1")], start, probes(open({ checks: [pass(), { name: "lint", state: "pending" }] })), tracked);
    expect(r).toMatchObject({ merge: [], reasons: [] });
  });

  test("a failing check never merges, and the orchestrator hears about it once per head", () => {
    const failing = open({ checks: [pass("lint"), { name: "test", state: "fail" }, { name: "build", state: "pending" }] });
    const first = scan([task("T1")], start, probes(failing), tracked);
    expect(first).toMatchObject({ merge: [], reasons: ["check-failed T1 #41: test"] });
    expect(scan([task("T1")], first.cursor, probes(failing), tracked).reasons).toEqual([]);
    const fixed = scan([task("T1")], first.cursor, probes(open({ sha: "def" })), tracked);
    expect(fixed.merge).toEqual([{ id: "T1", number: 41, sha: "def" }]);
  });

  test("a PR the reviewer hasn't approved, or that isn't delivered yet, waits", () => {
    expect(scan([task("T1")], start, probes(open(), { approved: false }), tracked).merge).toEqual([]);
    expect(scan([task("T1", { status: "done" })], start, probes(open()), tracked).merge).toEqual([]);
  });

  test("a PR that isn't from the task's foreman branch is never merged", () => {
    const decisions: TrackedPr[] = [{ key: "decisions", number: 41 }];
    expect(scan([task("T1")], start, probes(open({ head: "foreman/decisions" })), decisions).merge).toEqual([]);
    expect(scan([task("T1")], start, probes(open({ head: "release-please--branches--main" })), tracked).merge).toEqual([]);
  });

  test("a stacked PR waits until it targets the base branch", () => {
    const stacked = task("T2", { stackedOn: "T1" });
    const prs: TrackedPr[] = [{ key: "T2", number: 42, base: "main" }];
    const onParent = open({ head: "foreman/T2", base: "foreman/T1" });
    expect(scan([stacked], start, probes(onParent), prs).merge).toEqual([]);
    expect(scan([stacked], start, probes({ ...onParent, base: "main" }), prs).merge).toEqual([{ id: "T2", number: 42, sha: "abc" }]);
  });

  test("a draft, merged or closed PR waits", () => {
    for (const pr of [open({ draft: true }), open({ state: "MERGED" }), open({ state: "CLOSED" })]) {
      expect(scan([task("T1")], start, probes(pr), tracked).merge).toEqual([]);
    }
  });

  test("with automerge off nothing merges and failing checks stay quiet", () => {
    expect(scan([task("T1")], start, probes(open(), { on: false }), tracked).merge).toEqual([]);
    expect(scan([task("T1")], start, probes(open({ checks: [{ name: "test", state: "fail" }] }), { on: false }), tracked).reasons).toEqual([]);
  });

  test("a head the merge was refused for isn't tried again", () => {
    expect(scan([task("T1")], { ...start, unmergeable: { "41": "abc" } }, probes(open()), tracked).merge).toEqual([]);
  });
});

test("reads check runs and commit statuses from gh", () => {
  expect(checksOf([
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "CANCELLED" },
    { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
    { __typename: "StatusContext", context: "ci/deploy", state: "ERROR" },
  ])).toEqual([
    { name: "test", state: "pass" },
    { name: "docs", state: "pass" },
    { name: "lint", state: "pending" },
    { name: "e2e", state: "fail" },
    { name: "ci/legacy", state: "pending" },
    { name: "ci/deploy", state: "fail" },
  ]);
});

test("prefers squash, then a merge commit, then rebase", () => {
  expect(mergeMethod({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true })).toBe("squash");
  expect(mergeMethod({ mergeCommitAllowed: true, rebaseMergeAllowed: true })).toBe("merge");
  expect(mergeMethod({ rebaseMergeAllowed: true })).toBe("rebase");
});

const PLAN = `# Plan: Tags

## T1: feat: notes carry tags
- Owns: src/types.ts

### Intent
Notes have tags.

### Spec
Add tags to Note.
`;

describe("foreman automerge", () => {
  test("switches it for the current plan, and a new plan starts with it off", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    expect(automerge(repo, [])[0]).toStartWith("Automerge is off");
    expect(automerge(repo, ["on"])).toEqual([expect.stringMatching(/^Automerge is on until this plan finishes/)]);
    savePlan(repo, { ...loadPlan(repo)!, approvedAt: "now" });
    expect(automergeOn(repo)).toBe(true);
    expect(automerge(repo, ["off"])[0]).toStartWith("Automerge is off");
    automerge(repo, ["on"]);
    withTasks(repo, (tasks) => void tasks.push(...loadPlan(repo)!.tasks.map((t) => task(t.id, { status: "merged" }))));
    savePlan(repo, parsePlan(PLAN.replaceAll("T1", "T2")));
    expect(automergeOn(repo)).toBe(false);
  });

  test("changing and re-approving the plan mid-run keeps it on", () => {
    const repo = tempRepo();
    const T2 = PLAN.replaceAll("T1", "T2");
    savePlan(repo, parsePlan(PLAN + T2));
    automerge(repo, ["on"]);
    savePlan(repo, { ...loadPlan(repo)!, approvedAt: "now" });
    withTasks(repo, (tasks) => void tasks.push(task("T1", { status: "merged" })));
    savePlan(repo, parsePlan(PLAN + T2.replace("feat: notes carry tags", "feat: notes carry colours")));
    expect(automergeOn(repo)).toBe(true);
    savePlan(repo, parsePlan(PLAN + T2 + PLAN.replaceAll("T1", "T3")));
    expect(automergeOn(repo)).toBe(true);
    savePlan(repo, { ...loadPlan(repo)!, approvedAt: "later" });
    expect(automergeOn(repo)).toBe(true);
  });

  test("switching it on lists the never rules about merging", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    saveConfig(repo, { never: ["Merge a release PR. I cut every release.", "Push to main"] });
    expect(automerge(repo, ["on"]).slice(1)).toEqual(["Your never list mentions merging, and it still applies:", "  - Merge a release PR. I cut every release."]);
    expect(automerge(repo, ["off"])).toHaveLength(1);
  });

  test("needs a plan, and takes only on or off", () => {
    const repo = tempRepo();
    expect(() => automerge(repo, ["on"])).toThrow("no plan");
    savePlan(repo, parsePlan(PLAN));
    for (const bad of [["yes"], ["on", "off"]]) expect(() => automerge(repo, bad)).toThrow(UsageError);
  });
});
