import { expect, test } from "bun:test";
import type { TaskEvent } from "../src/events.ts";
import type { Task } from "../src/state.ts";
import { scan, type Cursor, type Probes } from "../src/watch.ts";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  status: "running",
  branch: `foreman/${id}`,
  base: "main",
  worktree: `/w/${id}`,
  owns: ["src/"],
  socket: "",
  rex: { session: "s", window: "w", block: `b-${id}` },
  createdAt: "",
  ...extra,
});

const ev = (type: TaskEvent["type"], note?: string): TaskEvent => ({ at: "", type, note });

function probes(events: Record<string, TaskEvent[]>, sha = "aaa", dead: string[] = []): Probes {
  return { events: (id) => events[id] ?? [], mainSha: () => sha, alive: (t) => !dead.includes(t.id) };
}

const empty: Cursor = { events: {}, exited: [] };

test("first scan records main without reporting it", () => {
  const r = scan([], empty, probes({}));
  expect(r.reasons).toEqual([]);
  expect(r.cursor.main).toBe("aaa");
});

test("reports each new event once", () => {
  const events = { T1: [ev("done", "built the pane")] };
  const first = scan([task("T1")], { ...empty, main: "aaa" }, probes(events));
  expect(first.reasons).toEqual(["done T1: built the pane"]);
  expect(scan([task("T1")], first.cursor, probes(events)).reasons).toEqual([]);
});

test("reports main moving and a worker exiting, once each", () => {
  const p = probes({}, "bbb", ["T2"]);
  const first = scan([task("T1"), task("T2")], { ...empty, main: "aaa" }, p);
  expect(first.reasons).toEqual(["exited T2", "main-moved bbb"]);
  expect(scan([task("T1"), task("T2")], first.cursor, p).reasons).toEqual([]);
});

test("reports a resumed worker exiting again, and never a worker Foreman stopped", () => {
  const first = scan([task("T1")], { ...empty, main: "aaa" }, probes({}, "aaa", ["T1"]));
  const resumed = scan([task("T1")], first.cursor, probes({}));
  expect(scan([task("T1")], resumed.cursor, probes({}, "aaa", ["T1"])).reasons).toEqual(["exited T1"]);
  expect(scan([task("T2", { status: "over-budget" })], { ...empty, main: "aaa" }, probes({}, "aaa", ["T2"])).reasons).toEqual([]);
});

test("reports new PR comments and a merge once each, only when gh was polled", () => {
  const prs = [{ key: "T1", number: 41 }];
  const p = (state: string, comments: number): Probes => ({ ...probes({}), pr: () => ({ state, comments }) });
  const first = scan([], { ...empty, main: "aaa" }, p("OPEN", 1), prs);
  expect(first.reasons).toEqual([]);
  const second = scan([], first.cursor, p("MERGED", 3), prs);
  expect(second.reasons).toEqual(["pr-comments T1 #41 (+2)", "merged T1 #41"]);
  expect(scan([], second.cursor, p("MERGED", 3), prs).reasons).toEqual([]);
  expect(scan([], first.cursor, probes({}), prs).reasons).toEqual([]);
});

test("clips long notes so the wake line stays one line", () => {
  const r = scan([task("T1")], { ...empty, main: "aaa" }, probes({ T1: [ev("blocked", "x".repeat(300))] }));
  expect(r.reasons[0]!.length).toBeLessThan(120);
});
