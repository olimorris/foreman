import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "../src/events.ts";
import type { Question } from "../src/questions.ts";
import type { Task } from "../src/state.ts";
import type { Proc } from "../src/procs.ts";
import { scan, type Cursor, type Probes } from "../src/watch.ts";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  status: "running",
  branch: `foreman/${id}`,
  base: "main",
  worktree: `/w/${id}`,
  owns: ["src/"],
  socket: "",
  tab: { session: "s", window: "w", pane: `b-${id}` },
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

describe("stalls", () => {
  const min = 60_000;
  const quiet = (last: number): Probes => ({ ...probes({}), lastActivity: () => last });
  const check = (now: number, waiting: string[] = []) => ({ now, stallMs: 20 * min, waiting: () => waiting });
  const start = { ...empty, main: "aaa" };

  test("nudges at the threshold and restarts at twice it, without waking the orchestrator", () => {
    expect(scan([task("T1")], start, quiet(0), [], check(19 * min)).nudge).toEqual([]);
    const nudged = scan([task("T1")], start, quiet(0), [], check(20 * min));
    expect(nudged).toMatchObject({ nudge: [{ id: "T1" }], restart: [], reasons: [] });
    expect(scan([task("T1")], nudged.cursor, quiet(0), [], check(30 * min))).toMatchObject({ nudge: [], restart: [] });
    const restarted = scan([task("T1")], nudged.cursor, quiet(0), [], check(40 * min));
    expect(restarted).toMatchObject({ restart: ["T1"], reasons: [] });
    expect(scan([task("T1")], restarted.cursor, quiet(0), [], check(90 * min)).restart).toEqual([]);
    expect(scan([task("T1")], restarted.cursor, quiet(50 * min), [], check(70 * min)).nudge.map((n) => n.id)).toEqual(["T1"]);
  });

  test("tells the orchestrator once a worker hangs again after two restarts", () => {
    let cursor: Cursor = start;
    let last = 0;
    for (let i = 0; i < 2; i++) {
      cursor = scan([task("T1")], cursor, quiet(last), [], check(last + 40 * min)).cursor;
      last += 50 * min;
    }
    const r = scan([task("T1")], cursor, quiet(last), [], check(last + 40 * min, ["T6"]));
    expect(r).toMatchObject({ restart: [], reasons: ["stuck T1: hung again after 2 restarts, and T6 waits on it"] });
  });

  describe("by CPU use", () => {
    const worker = task("T1", { socket: "/tmp/foreman-x/T1.sock" });
    // A worker running a build, with CPU time that grows by the given seconds each minute until it stops at quietFrom.
    const building = (perMinute: number, quietFrom = Infinity) => (now: number): Proc[] => [
      { pid: 10, ppid: 5, cpuMs: 1000, ageMs: now, command: "claude --messaging-socket-path /tmp/foreman-x/T1.sock" },
      { pid: 11, ppid: 10, cpuMs: 0, ageMs: now, command: "/bin/zsh -c source snapshot.sh && eval 'swift build'" },
      { pid: 12, ppid: 11, cpuMs: (Math.min(now, quietFrom) / min) * perMinute * 1000, ageMs: now, command: "/usr/bin/swift build -c release" },
    ];
    // One pass a minute for the given minutes, as the watcher would make, with the worker silent from minute 0.
    function passes(minutes: number, procs: (now: number) => Proc[], cursor: Cursor = start) {
      const seen: { at: number; nudge: string[]; restart: string[]; reasons: string[] }[] = [];
      for (let m = 0; m <= minutes; m++) {
        const now = m * min;
        const r = scan([worker], cursor, { ...probes({}), lastActivity: () => 0, processes: () => procs(now) }, [], check(now));
        cursor = r.cursor;
        if (r.nudge.length || r.restart.length || r.reasons.length) seen.push({ at: m, nudge: r.nudge.map((n) => n.text), restart: r.restart, reasons: r.reasons });
      }
      return seen;
    }

    test("leaves a silent worker alone while its commands use CPU, until four times the stall period", () => {
      expect(passes(90, building(30))).toEqual([{ at: 80, nudge: [], restart: ["T1"], reasons: [] }]);
    });

    test("nudges once its commands go quiet, naming the command, and restarts at twice the stall period", () => {
      const seen = passes(90, building(30, 30 * min));
      expect(seen.map((s) => [s.at, s.restart])).toEqual([[50, []], [70, ["T1"]]]);
      expect(seen[0]!.nudge[0]).toContain('"swift build -c release" in your worktree has used no CPU for 20 minutes');
    });

    test("counts a trickle of CPU under the busy line as quiet", () => {
      expect(passes(40, building(1)).map((s) => s.at)).toEqual([20, 40]);
    });

    test("says in the stuck line whether the command was busy or quiet", () => {
      const twice = { ...start, restarts: { T1: 2 } };
      expect(passes(80, building(30), twice).at(-1)!.reasons).toEqual(['stuck T1: hung again after 2 restarts, though "swift build -c release" is still using CPU']);
      expect(passes(40, building(0), twice).at(-1)!.reasons).toEqual(['stuck T1: hung again after 2 restarts, waiting on "swift build -c release", which uses no CPU']);
    });

    test("waits for a second look at CPU use before judging a worker that has been silent since before the watcher started", () => {
      const p = (now: number) => ({ ...probes({}), lastActivity: () => 0, processes: () => building(30)(now) });
      const first = scan([worker], start, p(50 * min), [], check(50 * min));
      expect(first).toMatchObject({ nudge: [], restart: [] });
      expect(scan([worker], first.cursor, p(51 * min), [], check(51 * min))).toMatchObject({ nudge: [], restart: [] });
    });

    test("leaves a serial make alone, whose compiler runs exit before ps can count their CPU", () => {
      const make = (now: number): Proc[] => [...building(0)(now).slice(0, 2), { pid: 12, ppid: 11, cpuMs: 50, ageMs: now, command: "make" }, { pid: 100 + now / min, ppid: 12, cpuMs: 20, ageMs: 1000, command: "cc -c foo.c" }];
      expect(passes(90, make).map((s) => [s.at, s.restart])).toEqual([[80, ["T1"]]]);
    });

    test("nudges about the hung test, not the dev server running beside it", () => {
      const both = (now: number): Proc[] => [
        ...building(0)(now),
        { pid: 20, ppid: 10, cpuMs: 0, ageMs: now, command: "/bin/zsh -c eval 'swift test'" },
        { pid: 21, ppid: 20, cpuMs: 0, ageMs: now - min, command: "swift test --filter Export" },
      ];
      expect(passes(20, both).at(-1)!.nudge[0]).toContain('"swift test --filter Export" in your worktree');
    });

    test("never counts the worker's own CPU use", () => {
      const thinking = (now: number) => [{ pid: 10, ppid: 5, cpuMs: now, ageMs: now, command: "claude --messaging-socket-path /tmp/foreman-x/T1.sock" }];
      expect(passes(20, thinking).map((s) => s.at)).toEqual([20]);
    });
  });

  test("leaves workers alone that aren't running", () => {
    expect(scan([task("T1", { status: "done" })], start, quiet(0), [], check(60 * min)).reasons).toEqual([]);
    expect(scan([task("T1", { status: "blocked" })], start, quiet(0), [], check(60 * min)).reasons).toEqual([]);
  });
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

describe("questions", () => {
  const min = 60_000;
  const asked = (id: string, extra: Partial<Question> = {}): Question => ({ id, question: "Tabs or spaces?", call: "spaces", askedAt: new Date(0).toISOString(), ...extra });
  const withQuestions = (questions: Question[]): Probes => ({ ...probes({}), questions: () => questions });
  const clock = (now: number, answerMs = 30 * min) => ({ now, stallMs: 20 * min, answerMs });
  const start = { ...empty, main: "aaa" };

  test("wakes the orchestrator once a question goes unanswered for answerMinutes", () => {
    const p = withQuestions([asked("Q-1"), asked("Q-2", { answeredAt: "x" }), asked("Q-3", { decision: "D-4" })]);
    expect(scan([], start, p, [], clock(29 * min)).reasons).toEqual([]);
    const late = scan([], start, p, [], clock(30 * min));
    expect(late.reasons).toEqual(["unanswered Q-1: Tabs or spaces?", "unanswered Q-3 (D-4): Tabs or spaces?"]);
    expect(scan([], late.cursor, p, [], clock(90 * min)).reasons).toEqual([]);
  });

  test("never wakes for questions when answerMinutes is 0", () => {
    expect(scan([], start, withQuestions([asked("Q-1")]), [], clock(600 * min, 0)).reasons).toEqual([]);
  });

  test("forgets an answered question", () => {
    const late = scan([], start, withQuestions([asked("Q-1")]), [], clock(30 * min));
    expect(scan([], late.cursor, withQuestions([asked("Q-1", { answeredAt: "x" })]), [], clock(31 * min)).cursor.unanswered).toEqual([]);
  });
});

test("clips long notes so the wake line stays one line", () => {
  const r = scan([task("T1")], { ...empty, main: "aaa" }, probes({ T1: [ev("blocked", "x".repeat(300))] }));
  expect(r.reasons[0]!.length).toBeLessThan(120);
});
