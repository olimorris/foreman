import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deliver, modelName, renderPacket, section } from "../src/deliver.ts";
import { appendEvent, readEvents } from "../src/events.ts";
import { saveConfig } from "../src/config.ts";
import { must } from "../src/exec.ts";
import { savePlan } from "../src/plan.ts";
import type { Verdict } from "../src/rounds.ts";
import { spawn } from "../src/spawn.ts";
import { findTask, updateTask } from "../src/state.ts";
import { sync } from "../src/sync.ts";
import { teardown } from "../src/teardown.ts";
import { fakeTerminal, tempRepo, writeRound } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");

const approve: Verdict = { verdict: "approve", summary: "Matches the intent.", issues: [], risk: "low", risk_note: "Copy change only.", decisions_touched: [] };
const noProbes = { fetch: () => {}, prState: () => undefined, prBase: () => undefined, setPrBase: () => false };

function setup(ids: string[]) {
  const repo = tempRepo();
  const term = fakeTerminal();
  for (const id of ids) {
    const brief = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
    writeFileSync(brief, `## Intent\n\nGreet in ${id}.\n\n## Spec\n\nWrite ${id}.txt.\n`);
    spawn(repo, { id, brief, owns: [`${id}.txt`], base: "main", session: "s" }, term);
  }
  const commit = (id: string) => {
    const wt = findTask(repo, id).worktree;
    writeFileSync(join(wt, `${id}.txt`), "hi\n");
    must(["git", "-C", wt, "add", "."]);
    must(["git", "-C", wt, "commit", "-qm", `add ${id}`]);
  };
  return { repo, term, commit };
}

test("section reads one Markdown section", () => {
  expect(section("# T\n\n## Intent\n\nDo it.\n\n## Spec\n\nHow.\n", "Intent")).toBe("Do it.");
  expect(section("## Spec\nx\n", "Intent")).toBe("");
});

test("the packet carries intent, change, screenshots, verdict and risk", () => {
  const { repo } = setup(["T1"]);
  const md = renderPacket({
    task: findTask(repo, "T1"), intent: "Greet.", doneNote: "Added a greeting", test: ["Open the app. It says hi."], assumptions: ["Hi, not hello."], stat: "1 file changed", verdict: approve, round: 2,
    decisions: ["D-1 Notes carry tags (accepted)"], shots: [{ name: "home", before: "https://x/b.png", after: "https://x/a.png" }],
    models: { worker: ["claude-opus-5-5", "claude-sonnet-5-5"], reviewer: ["claude-opus-5-5"] },
  });
  expect(md).toContain("Worker: Opus 5.5 and Sonnet 5.5. Reviewer: Opus 5.5.");
  expect(md).toContain("checked the diff and before and after screenshots against the intent above. It approved in round 2: Matches the intent.");
  expect(md).toContain("## Description\n\nGreet.");
  expect(md).toContain("## How to test\n\n1. Open the app. It says hi.");
  expect(md).toContain("## Assumptions\n\n- Hi, not hello.");
  expect(md).toContain("- D-1 Notes carry tags (accepted)");
  expect(md).toContain('| home | <img src="https://x/b.png" width="400"> | <img src="https://x/a.png" width="400"> |');
  expect(md).toContain("**low**: Copy change only.");
  expect(md).toContain("A person set its scope and merges it.");
});

test("with automerge on, the packet says Foreman merges the PR", () => {
  const { repo } = setup(["T1"]);
  const md = renderPacket({ task: findTask(repo, "T1"), intent: "Greet.", stat: "", verdict: approve, round: 1, decisions: [], shots: [], automerge: true, models: { worker: [], reviewer: [] } });
  expect(md).toContain("AI wrote this change. A person set its scope, and Foreman merges it once its checks pass.");
});

test("a PR above maxRisk, or one that touches a protected path, says a person merges it", () => {
  const { repo } = setup(["T1"]);
  const packet = (extra: object) => renderPacket({ task: findTask(repo, "T1"), intent: "Greet.", stat: "", verdict: approve, round: 1, decisions: [], shots: [], automerge: true, models: { worker: [], reviewer: [] }, ...extra });
  const person = "AI wrote this change. A person set its scope and merges it.";
  expect(packet({ verdict: { ...approve, risk: "medium" } })).toContain(person);
  expect(packet({ verdict: { ...approve, risk: "medium" }, maxRisk: "medium" })).toContain("Foreman merges it once its checks pass");
  expect(packet({ protectedFiles: ["migrations/0004.sql"] })).toContain(person);
  expect(packet({ protectedFiles: [] })).toContain(person);
});

test("deliver checks the branch's files against the protect list", () => {
  const { repo, commit } = setup(["T1"]);
  commit("T1");
  writeRound(repo, "T1", 1, { verdict: approve });
  updateTask(repo, "T1", { reviews: 1 });
  savePlan(repo, { title: "Greet", automerge: true, tasks: [] });
  const usage = () => readFileSync(deliver(repo, "T1", { dryRun: true, title: "feat: greet" }).packet, "utf8");
  expect(usage()).toContain("Foreman merges it once its checks pass");
  saveConfig(repo, { protect: ["*.txt"] });
  expect(usage()).toContain("A person set its scope and merges it.");
  saveConfig(repo, { protect: ["migrations/**"] });
  expect(usage()).toContain("Foreman merges it once its checks pass");
});

test("deliver refuses until the latest review approves, then writes the packet", () => {
  const { repo, commit } = setup(["T1"]);
  commit("T1");
  expect(() => deliver(repo, "T1", { dryRun: true })).toThrow("no finished review");
  writeRound(repo, "T1", 1, { verdict: { ...approve, verdict: "changes" } });
  updateTask(repo, "T1", { reviews: 1 });
  expect(() => deliver(repo, "T1", { dryRun: true })).toThrow("asked for changes");
  writeRound(repo, "T1", 1, { verdict: approve });
  appendEvent(repo, "T1", "done", "Greets in T1");
  expect(() => deliver(repo, "T1")).toThrow("conventional commits");
  const r = deliver(repo, "T1", { title: "feat: greet in T1" });
  expect(r.note).toContain("no origin remote");
  const md = readFileSync(r.packet, "utf8");
  expect(md).toContain("Greet in T1.");
  expect(md).toContain("Greets in T1");
  expect(md).toContain("T1.txt");
});

test("sync marks a merged task, asks the others to rebase once, and teardown accepts the merge", () => {
  const { repo, term, commit } = setup(["T1", "T2", "T3"]);
  commit("T1");
  commit("T2");
  expect(sync(repo, "main", term, noProbes)).toMatchObject({ merged: [], asked: [] });

  must(["git", "-C", repo.root, "merge", "-q", "--no-ff", "-m", "merge T1", "foreman/T1"]);
  const r = sync(repo, "main", term, noProbes);
  expect(r.merged).toEqual(["T1"]);
  expect(r.asked.sort()).toEqual(["T2", "T3"]);
  expect(findTask(repo, "T1")).toMatchObject({ status: "merged" });
  const inbox = term.sent.join("\n");
  expect(inbox).toContain("Foreman message waiting");
  expect(sync(repo, "main", term, noProbes).asked).toEqual([]);

  expect(teardown(repo, "T1", false, term).removed).toBe(true);
});

test("a task that rebased before its first commit isn't taken as merged", () => {
  const { repo, term } = setup(["T1"]);
  writeFileSync(join(repo.root, "main.txt"), "moved\n");
  must(["git", "-C", repo.root, "add", "."]);
  must(["git", "-C", repo.root, "commit", "-qm", "main moves"]);
  must(["git", "-C", findTask(repo, "T1").worktree, "rebase", "-q", "main"]);
  expect(sync(repo, "main", term, noProbes).merged).toEqual([]);
  expect(findTask(repo, "T1").mergedAt).toBeUndefined();
});

test("a task that rebased onto another task's merge commit before its first commit isn't taken as merged", () => {
  const { repo, term, commit } = setup(["T1", "T2"]);
  commit("T1");
  must(["git", "-C", repo.root, "merge", "-q", "--no-ff", "-m", "merge T1", "foreman/T1"]);
  must(["git", "-C", findTask(repo, "T2").worktree, "rebase", "-q", "main"]);
  expect(sync(repo, "main", term, noProbes).merged).toEqual(["T1"]);
});

test("a task fast-forwarded into the base is taken as merged", () => {
  const { repo, term, commit } = setup(["T1"]);
  commit("T1");
  must(["git", "-C", repo.root, "merge", "-q", "--ff-only", "foreman/T1"]);
  expect(sync(repo, "main", term, noProbes).merged).toEqual(["T1"]);
});

test("sync trusts a merged PR even when the branch was squashed", () => {
  const { repo, term, commit } = setup(["T1"]);
  commit("T1");
  updateTask(repo, "T1", { pr: 7 });
  const r = sync(repo, "main", term, { ...noProbes, prState: (n) => (n === 7 ? "MERGED" : undefined) });
  expect(r.merged).toEqual(["T1"]);
  expect(readEvents(repo, "T1")).toEqual([]);
});

test("modelName turns model ids into the names people use", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
  expect(modelName("gpt-x")).toBe("gpt-x");
});

describe("a pull-request skill's draft", () => {
  const draft = { title: "feat: greet people in T1", description: "## Summary\n\nT1 says hi.\n\n## Why\n\nIt was rude." };

  function approved(verdict: Verdict) {
    const { repo, commit } = setup(["T1"]);
    commit("T1");
    writeRound(repo, "T1", 1, { verdict });
    updateTask(repo, "T1", { reviews: 1 });
    appendEvent(repo, "T1", "done", "Greets in T1", { test: ["Open T1.txt. It says hi."], assumptions: ["Hi, not hello."] });
    return repo;
  }

  test("writes the PR's title and opening, and Foreman's own sections follow it", () => {
    const r = deliver(approved({ ...approve, decisions_touched: [], pr: draft }), "T1", { dryRun: true });
    expect(r.title).toBe("feat: greet people in T1");
    const md = readFileSync(r.packet, "utf8");
    expect(md).toStartWith("## Summary\n\nT1 says hi.\n\n## Why\n\nIt was rude.\n\n## Intent\n\nGreet in T1.\n");
    expect(md).not.toContain("## Description");
    expect(md).not.toContain("## How to test");
    for (const part of ["## Assumptions\n\n- Hi, not hello.", "## Decisions", "## AI Usage", "It approved in round 1: Matches the intent.", "## Screenshots", "## Risk\n\n**low**: Copy change only."]) expect(md).toContain(part);
  });

  test("gives way to --title, and to the task's title when it isn't a conventional commit", () => {
    expect(deliver(approved({ ...approve, pr: draft }), "T1", { dryRun: true, title: "fix: mine" }).title).toBe("fix: mine");
    const repo = approved({ ...approve, pr: { ...draft, title: "Greet people" } });
    updateTask(repo, "T1", { title: "feat: greet in T1" });
    const r = deliver(repo, "T1", { dryRun: true });
    expect(r.title).toBe("feat: greet in T1");
    expect(r.note).toContain(`The pull-request skill's title "Greet people" isn't a conventional commit`);
  });

  test("without one, the packet is Foreman's own", () => {
    const r = deliver(approved(approve), "T1", { dryRun: true, title: "feat: greet in T1" });
    const md = readFileSync(r.packet, "utf8");
    expect(md).toStartWith("## Description\n\nGreet in T1.");
    expect(md).toContain("## How to test\n\n1. Open T1.txt. It says hi.");
  });
});
