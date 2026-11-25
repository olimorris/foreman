import { expect, test } from "bun:test";
import { renderPane, type PaneInput, type PaneTask } from "../src/pane.ts";
import type { Task } from "../src/state.ts";

const NOW = Date.parse("2026-11-25T08:40:00Z");
const ago = (min: number) => NOW - min * 60_000;
const at = (min: number) => new Date(ago(min)).toISOString();

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task =>
  ({ id, status, branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: [], socket: "", createdAt: at(60), ...extra });
const row = (t: Task, extra: Partial<PaneTask> = {}): PaneTask => ({ task: t, title: `build ${t.id.toLowerCase()}`, spent: 1.5, ...extra });

export const sample: PaneInput = {
  name: "notes", plan: "Tags and search", deadline: "Friday", approved: true, armed: true, now: NOW, stallMs: 20 * 60_000,
  spent: 12.4, limit: 40, maxWorkers: 4,
  tasks: [
    row(task("T1", "torn-down", { mergedAt: at(30), pr: 4, worker: "W1" })),
    row(task("T2", "running", { worker: "W1" }), { title: "filter notes by tag", activity: { what: "$ bun test", since: ago(3), idle: false } }),
    row(task("T3", "running", { worker: "W2" }), { title: "search notes as you type", activity: { what: "waiting", since: ago(25), idle: true } }),
    row(task("T4", "needs-decision", { worker: "W3" }), { title: "export notes as JSON", note: "Should exports include archived notes?" }),
    row(task("T5", "pr-open", { pr: 7 }), { title: "show tag colours", risk: "medium" }),
  ],
  waiting: [{ id: "T6", reason: "waits for T2 to merge", title: "feat: tag suggestions" }],
  recent: [{ at: ago(1), text: "T5 finished: tag colours on the list" }],
  decisions: [{ id: "D-2", title: "Tag names are lowercase", by: "T2" }],
};

test("the pane puts what needs the user first, then the crew, PRs and what's waiting", () => {
  const lines = renderPane(sample, 60);
  const find = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(lines[0]).toMatch(/^FOREMAN  notes +\d\d:\d\d$/);
  expect(lines).toContain("$12.40 of $40.00 spent · 4 of 4 slots · watcher on");
  const order = ["NEEDS YOU", "T4", "Should exports include archived notes?", "D-2", "WORKING", "filter notes by tag", "$ bun test", "search notes as you type", "idle", "READY TO MERGE", "#7 risk medium", "WAITING", "waits for T2 to merge", "Merged: T1 #4", "RECENT"];
  const at = order.map(find);
  expect(at.every((n) => n >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("every line fits the pane, and a worker quiet past the stall time shows red", () => {
  for (const width of [40, 60, 90]) for (const l of renderPane(sample, width)) expect(l.length).toBeLessThanOrEqual(width);
  const quiet = renderPane(sample, 60, true).find((l) => l.includes("idle"))!;
  expect(quiet).toContain("\x1b[31midle");
});

test("a running task whose worker tab has closed moves to Needs you", () => {
  const closed = { ...sample, tasks: sample.tasks.map((t) => (t.task.id === "T2" ? { ...t, closed: true } : t)) };
  const lines = renderPane(closed, 60);
  const t2 = lines.findIndex((l) => l.includes("filter notes by tag"));
  expect(t2).toBeLessThan(lines.indexOf("WORKING"));
  expect(lines[t2]).toContain("worker closed");
});

test("while the account waits for its usage limit, the pane says when work resumes and which workers are paused", () => {
  const waiting: PaneInput = {
    ...sample,
    usageLimit: { since: ago(10), resetsAt: Date.parse("2026-11-25T10:15:00Z"), by: "T2", paused: ["T2"], announced: true },
    tasks: [row(task("T2", "limited", { worker: "W1" }), { title: "filter notes by tag" }), row(task("T6", "done", { worker: "W2" }), { title: "tag colours" })],
  };
  const lines = renderPane(waiting, 60);
  expect(lines.some((l) => /^Usage limit reached · work resumes at \d\d:\d\d$/.test(l))).toBe(true);
  expect(lines[lines.findIndex((l) => l.includes("filter notes by tag")) + 1]).toContain("paused until the usage limit resets");
  expect(lines[lines.findIndex((l) => l.includes("tag colours")) + 1]).toContain("review waits for the usage limit");
});

test("open permission blocks move their task to Needs you, each with what was blocked", () => {
  const blocks: PaneInput["blocks"] = [
    { role: "worker", task: "T2", worker: "W1", id: "x1", at: at(2), kind: "prompt", tool: "Bash", target: "gh pr merge 41", rule: "Bash(gh pr merge *)" },
    { role: "orchestrator", id: "o1", at: at(1), kind: "auto-mode", tool: "Bash", target: "gh run list", rule: "Bash(gh run list *)" },
  ];
  const lines = renderPane({ ...sample, blocks }, 90);
  const find = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(find("The orchestrator")).toBe(find("NEEDS YOU") + 1);
  expect(lines[find("The orchestrator")]).toMatch(/needs a permission$/);
  expect(lines[find("The orchestrator") + 2]).toContain("allow it with Bash(gh run list *)");
  expect(lines[find("filter notes by tag")]).toMatch(/waiting at a permission prompt$/);
  expect(lines[find("filter notes by tag") + 1]).toContain("waiting at a permission prompt to run `gh pr merge 41`");
  expect(find("filter notes by tag")).toBeLessThan(find("WORKING"));
  for (const l of renderPane({ ...sample, blocks }, 40)) expect(l.length).toBeLessThanOrEqual(40);
});
