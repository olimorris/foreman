import { expect, test } from "bun:test";
import { readActivity, renderPane, type PaneInput, type PaneTask } from "../src/pane.ts";
import type { Task } from "../src/state.ts";

const NOW = Date.parse("2026-11-25T08:40:00Z");
const ago = (min: number) => NOW - min * 60_000;
const at = (min: number) => new Date(ago(min)).toISOString();

const assistant = (min: number, content: object[], stop: string | null = "tool_use") =>
  JSON.stringify({ type: "assistant", timestamp: at(min), message: { content, stop_reason: stop } });
const result = (min: number, id: string) => JSON.stringify({ type: "user", timestamp: at(min), message: { content: [{ type: "tool_result", tool_use_id: id }] } });

test("a tool call still waiting for its result is what the worker is doing", () => {
  const lines = [
    assistant(10, [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: "/w/T1/src/tags.ts" } }]),
    result(9, "a"),
    assistant(8, [{ type: "tool_use", id: "b", name: "Bash", input: { command: "cd /w/T1; timeout 900 swift test -j 1\necho done" } }]),
  ];
  expect(readActivity(lines, "/w/T1")).toEqual({ what: "$ timeout 900 swift test -j 1", since: ago(8), idle: false });
});

test("a worker whose last reply ended its turn is waiting, and one with a fresh tool result is thinking", () => {
  const edit = assistant(10, [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/w/T1/README.md" } }]);
  expect(readActivity([edit, result(9, "a"), assistant(7, [{ type: "text", text: "Done." }], "end_turn")], "/w/T1")).toEqual({ what: "waiting", since: ago(7), idle: true });
  expect(readActivity([edit, result(9, "a")], "/w/T1")).toEqual({ what: "thinking", since: ago(9), idle: false });
  expect(readActivity([edit], "/w/T1")?.what).toBe("reading README.md");
});

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
