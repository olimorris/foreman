import { expect, test } from "bun:test";
import { forTerminal, renderSummary, reviewOrder, type Ready } from "../src/summary.ts";
import { parsePlan } from "../src/plan.ts";
import type { Task } from "../src/state.ts";
import type { Verdict } from "../src/review.ts";

const task = (id: string, pr: number): Task => ({ id, status: "pr-open", branch: `foreman/${id}`, base: "main", worktree: "/w", owns: [], socket: "/s", createdAt: "", pr });
const verdict = (risk: Verdict["risk"], risk_note = ""): Verdict => ({ verdict: "approve", summary: "ok", issues: [], risk, risk_note, decisions_touched: [] });
const ready = (id: string, pr: number, risk: Verdict["risk"], blocks: string[] = [], extra: Partial<Ready> = {}): Ready =>
  ({ task: task(id, pr), title: `feat: ${id}`, verdict: verdict(risk), blocks, ...extra });

test("PRs others wait on come first, then riskier ones", () => {
  const order = reviewOrder([ready("T4", 4, "low"), ready("T3", 3, "high"), ready("T1", 1, "low", ["T2"]), ready("T5", 5, "medium")]);
  expect(order.map((r) => r.task.id)).toEqual(["T1", "T3", "T5", "T4"]);
});

test("the summary says why each PR is where it is, how to test it and what to check", () => {
  const md = renderSummary({
    title: "Notes", merged: ["T0"], calls: ["Search runs on Enter."], cut: ["JSON download, to make the deadline."], spent: 14.2, limit: 40,
    open: [{ id: "D-2", title: "Tag names are lowercase", body: "", paths: [], supersedes: [], status: "proposed", by: "T3", createdAt: "" }],
    unfinished: [{ id: "T6", title: "feat: dark mode", reason: "blocked, waiting on you" }],
    ready: [
      ready("T3", 4, "medium", [], { done: { at: "", type: "done", test: ["Select work on the list. Only work notes show."] } }),
      ready("T1", 2, "low", ["T2", "T3"], { done: { at: "", type: "done", test: ["Open a note. Its tags show under the body."], assumptions: ["Tags can't be edited in the app."] } }),
    ],
  });
  expect(md).toContain("2 PR(s) ready, $14.20 spent of $40.00. 1 task(s) not finished.");
  expect(md).toContain("1. **#2 feat: T1** (T1) - T2 and T3 wait for this, so it goes first\n   - Test:\n     - Open a note. Its tags show under the body.\n   - Check: Tags can't be edited in the app.\n   - Risk: low");
  expect(md).toContain("2. **#4 feat: T3** (T3) - risk medium, so review it early");
  expect(md).toContain("- **feat: dark mode** (T6): blocked, waiting on you");
  expect(md).toContain("## Calls Foreman made for you\n\n- Search runs on Enter.");
  expect(md).toContain("- D-2: Tag names are lowercase. Proposed by T3 and not decided yet.\n- Cut: JSON download, to make the deadline.");
});

test("the plan's head carries the calls and cuts", () => {
  const p = parsePlan("# Plan: Notes\nDeadline: Friday\nCalls:\n- Search runs on Enter.\n- Footer counts all notes.\nCut:\n- JSON download\n\n## T1: feat: a\n- Owns: x\n\n### Intent\ni\n\n### Spec\ns\n");
  expect(p.calls).toEqual(["Search runs on Enter.", "Footer counts all notes."]);
  expect(p.cut).toEqual(["JSON download"]);
  expect(p.deadline).toBe("Friday");
});

test("the terminal copy shows headings, bold and code as colour instead of Markdown marks", () => {
  expect(forTerminal("# Run summary: Notes\n1. **#2 add tags** (T1)\n- Run `foreman budget`")).toBe(
    "\x1b[1;33mRun summary: Notes\x1b[0m\n1. \x1b[1m#2 add tags\x1b[0m (T1)\n- Run \x1b[36mforeman budget\x1b[0m",
  );
});
