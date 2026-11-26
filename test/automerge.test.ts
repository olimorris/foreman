import { describe, expect, test } from "bun:test";
import { allowNoChecks, automerge, automergeOn, checksOf, foremanMerges, maxRisk, mergeMethod, protectedHits, riskHold, type Check, type Risk } from "../src/automerge.ts";
import { protectedLines } from "../src/brief.ts";
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

type Opts = { on?: boolean; approved?: boolean; noChecks?: boolean; risk?: Risk | null; max?: Risk; protect?: string[]; changed?: string[] | null };

// risk null stands for an old verdict written before the reviewer gave one.
function probes(pr: PrState, opts: Opts = {}): Probes {
  const verdict = { verdict: opts.approved === false ? ("changes" as const) : ("approve" as const), ...(opts.risk === null ? {} : { risk: opts.risk ?? "low" }) };
  return {
    events: () => [], mainSha: () => "aaa", alive: () => true, pr: () => pr, automerge: () => opts.on ?? true, verdict: () => verdict,
    allowNoChecks: () => opts.noChecks ?? false, ...(opts.max ? { maxRisk: () => opts.max! } : {}),
    ...(opts.protect ? { protect: () => opts.protect! } : {}), changed: () => (opts.changed === null ? undefined : opts.changed ?? []),
  };
}

describe("merging approved PRs", () => {
  test("an approved PR with green checks merges at its head", () => {
    expect(scan([task("T1")], start, probes(open()), tracked).merge).toEqual([{ id: "T1", number: 41, sha: "abc" }]);
  });

  test("a PR with no checks waits, and the orchestrator hears about it once per PR", () => {
    const bare = open({ checks: [] });
    const first = scan([task("T1")], start, probes(bare), tracked);
    expect(first).toMatchObject({ merge: [], reasons: ["no-checks T1 #41"] });
    expect(scan([task("T1")], first.cursor, probes(bare), tracked)).toMatchObject({ merge: [], reasons: [] });
    expect(scan([task("T1")], first.cursor, probes(open({ checks: [], sha: "def" })), tracked)).toMatchObject({ merge: [], reasons: [] });
    expect(scan([task("T1")], first.cursor, probes(open()), tracked).merge).toEqual([{ id: "T1", number: 41, sha: "abc" }]);
  });

  test("a PR with no checks merges once approved when allowNoChecks is on", () => {
    const r = scan([task("T1")], start, probes(open({ checks: [] }), { noChecks: true }), tracked);
    expect(r).toMatchObject({ merge: [{ id: "T1", number: 41, sha: "abc" }], reasons: [] });
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

  test("a PR at or below maxRisk merges, and one above it waits", () => {
    const merged = [{ id: "T1", number: 41, sha: "abc" }];
    expect(scan([task("T1")], start, probes(open(), { risk: "medium", max: "medium" }), tracked).merge).toEqual(merged);
    expect(scan([task("T1")], start, probes(open(), { risk: "low", max: "medium" }), tracked).merge).toEqual(merged);
    expect(scan([task("T1")], start, probes(open(), { risk: "high", max: "medium" }), tracked)).toMatchObject({ merge: [], reasons: ["too-risky T1 #41: high, above maxRisk medium"] });
    expect(scan([task("T1")], start, probes(open(), { risk: "high", max: "high" }), tracked).merge).toEqual(merged);
  });

  test("with no maxRisk only a low risk PR merges, and a verdict without a risk counts as medium", () => {
    expect(scan([task("T1")], start, probes(open(), { risk: "low" }), tracked).merge).toHaveLength(1);
    expect(scan([task("T1")], start, probes(open(), { risk: "medium" }), tracked)).toMatchObject({ merge: [], reasons: ["too-risky T1 #41: medium, above maxRisk low"] });
    expect(scan([task("T1")], start, probes(open(), { risk: null }), tracked)).toMatchObject({ merge: [], reasons: ["too-risky T1 #41: medium, above maxRisk low"] });
  });

  test("a PR above maxRisk is reported once, and merges if a later round lowers its risk", () => {
    const first = scan([task("T1")], start, probes(open(), { risk: "medium" }), tracked);
    expect(scan([task("T1")], first.cursor, probes(open({ sha: "def" }), { risk: "medium" }), tracked)).toMatchObject({ merge: [], reasons: [] });
    expect(scan([task("T1")], first.cursor, probes(open(), { risk: "low" }), tracked).merge).toHaveLength(1);
  });

  test("a PR above maxRisk with a failing check goes back to its worker first", () => {
    const failing = open({ checks: [{ name: "test", state: "fail" }] });
    expect(scan([task("T1")], start, probes(failing, { risk: "high" }), tracked).reasons).toEqual(["check-failed T1 #41: test"]);
    expect(scan([task("T1")], start, probes(open({ checks: [{ name: "test", state: "pending" }] }), { risk: "high" }), tracked).reasons).toEqual([]);
  });

  test("a PR that touches a protected path waits, and the orchestrator hears the matched paths once per PR", () => {
    const opts = { protect: ["migrations/**", ".github/"], changed: ["src/a.ts", "migrations/0004.sql", ".github/workflows/ci.yml"] };
    const first = scan([task("T1")], start, probes(open(), opts), tracked);
    expect(first).toMatchObject({ merge: [], reasons: ["protected T1 #41: migrations/0004.sql, .github/workflows/ci.yml"] });
    expect(scan([task("T1")], first.cursor, probes(open({ sha: "def" }), opts), tracked)).toMatchObject({ merge: [], reasons: [] });
    expect(scan([task("T1")], first.cursor, probes(open({ sha: "def" }), { ...opts, changed: ["src/a.ts"] }), tracked).merge).toEqual([{ id: "T1", number: 41, sha: "def" }]);
  });

  test("a PR that touches no protected path merges, and with no protect list the files aren't listed", () => {
    expect(scan([task("T1")], start, probes(open(), { protect: ["migrations/**"], changed: ["src/a.ts"] }), tracked).merge).toHaveLength(1);
    let listed = false;
    const p = { ...probes(open()), changed: () => ((listed = true), ["migrations/0004.sql"]) };
    expect(scan([task("T1")], start, p, tracked).merge).toHaveLength(1);
    expect(scan([task("T1")], start, { ...p, protect: () => [] }, tracked).merge).toHaveLength(1);
    expect(listed).toBe(false);
  });

  test("with a protect list, a PR whose files can't be listed waits", () => {
    expect(scan([task("T1")], start, probes(open(), { protect: ["migrations/**"], changed: null }), tracked)).toMatchObject({ merge: [], reasons: ["protected T1 #41: couldn't list its changed files, so it waits"] });
  });

  test("a protected PR with a failing check goes back to its worker first", () => {
    const failing = open({ checks: [{ name: "test", state: "fail" }] });
    expect(scan([task("T1")], start, probes(failing, { protect: ["migrations/**"], changed: ["migrations/1.sql"] }), tracked).reasons).toEqual(["check-failed T1 #41: test"]);
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
    expect(automerge(repo, ["on"])).toEqual([expect.stringMatching(/^Automerge is on until this plan finishes/), expect.stringMatching(/low risk/)]);
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
    expect(automerge(repo, ["on"]).slice(2)).toEqual(["Your never list mentions merging, and it still applies:", "  - Merge a release PR. I cut every release."]);
    expect(automerge(repo, ["off"])).toHaveLength(1);
  });

  test("switching it on names the risk level in force, low unless maxRisk says otherwise", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    expect(maxRisk(repo)).toBe("low");
    expect(automerge(repo, ["on"])[1]).toStartWith("It only merges PRs the reviewer rated low risk. Medium and high risk PRs stay with you");
    saveConfig(repo, { automerge: { maxRisk: "medium" } });
    expect(automerge(repo, ["on"])[1]).toStartWith("It merges PRs the reviewer rated low or medium risk");
    expect(automerge(repo, [])[1]).toStartWith("It merges PRs the reviewer rated low or medium risk");
    saveConfig(repo, { automerge: { maxRisk: "Medium" as Risk } });
    expect(maxRisk(repo)).toBe("low");
  });

  test("switching it on lists the protected paths", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    expect(automerge(repo, ["on"]).join("\n")).not.toContain("protected");
    saveConfig(repo, { protect: ["migrations/**", " ", ".github/**"] });
    expect(automerge(repo, ["on"]).slice(2)).toEqual(["It never merges a PR that touches a protected path, set by protect in .foreman/config.json:", "  - migrations/**", "  - .github/**"]);
  });

  test("status and the pane say why an approved PR above maxRisk waits", () => {
    expect(riskHold({ verdict: "approve", risk: "medium" }, "low")).toBe("waits for you: risk medium is above maxRisk low");
    expect(riskHold({ verdict: "approve" }, "low")).toBe("waits for you: risk medium is above maxRisk low");
    expect(riskHold({ verdict: "approve", risk: "medium" }, "medium")).toBeUndefined();
    expect(riskHold({ verdict: "changes", risk: "high" }, "low")).toBeUndefined();
  });

  test("switching it on mentions allowNoChecks only when it's set", () => {
    const repo = tempRepo();
    savePlan(repo, parsePlan(PLAN));
    expect(automerge(repo, ["on"])).toHaveLength(2);
    expect(allowNoChecks(repo)).toBe(false);
    saveConfig(repo, { automerge: { allowNoChecks: true } });
    expect(allowNoChecks(repo)).toBe(true);
    expect(automerge(repo, ["on"])[2]).toStartWith("automerge.allowNoChecks is on in .foreman/config.json");
  });

  test("needs a plan, and takes only on or off", () => {
    const repo = tempRepo();
    expect(() => automerge(repo, ["on"])).toThrow("no plan. This switches it for the current plan, and the orchestrator stores one with the plan tool");
    savePlan(repo, parsePlan(PLAN));
    for (const bad of [["yes"], ["on", "off"]]) expect(() => automerge(repo, bad)).toThrow(UsageError);
  });
});

describe("protected paths", () => {
  test("match changed files with the owned-path globs", () => {
    expect(protectedHits([], ["migrations/1.sql"])).toBeUndefined();
    expect(protectedHits(["migrations/**"], ["src/a.ts"])).toBeUndefined();
    expect(protectedHits(["migrations/**", "*.lock"], ["migrations/1.sql", "bun.lock", "src/a.ts"])).toEqual(["migrations/1.sql", "bun.lock"]);
    expect(protectedHits(["migrations/**"], undefined)).toEqual([]);
  });

  test("Foreman merges only with automerge on, at or below maxRisk and with nothing protected", () => {
    expect(foremanMerges(true, "low", "low", undefined)).toBe(true);
    expect(foremanMerges(false, "low", "low", undefined)).toBe(false);
    expect(foremanMerges(true, "medium", "low", undefined)).toBe(false);
    expect(foremanMerges(true, "low", "low", ["migrations/1.sql"])).toBe(false);
  });

  test("every brief lists them, saying the PR then stays with the user", () => {
    expect(protectedLines({})).toEqual([]);
    expect(protectedLines({ protect: ["migrations/**", ".github/**"] })).toEqual(["- Protected paths: `migrations/**`, `.github/**`. You can edit these, but a PR that touches one never automerges and stays with the user"]);
  });
});
