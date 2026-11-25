import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession, sessionsFile, transcriptDir } from "../src/transcripts.ts";
import type { RunEntry, TaskEvent } from "../src/events.ts";
import { styleFor } from "../src/help.ts";
import type { Task } from "../src/state.ts";
import { writeJson } from "../src/store.ts";
import { buildTimeline, duration, gatherTimeline, quietStretches, renderTimeline, type History, type TimelineInput } from "../src/timeline.ts";
import { tempRepo } from "./helpers.ts";

process.env.TZ = "UTC";

const MIN = 60_000;
const at = (hhmm: string, day = 25) => Date.parse(`2026-11-${day}T${hhmm}:00Z`);
const iso = (hhmm: string, day = 25) => new Date(at(hhmm, day)).toISOString();
const plain = styleFor({ isTTY: false });
const busy = (from: number, to: number) => Array.from({ length: (to - from) / (8 * MIN) + 1 }, (_, i) => from + i * 8 * MIN);

const history = (id: string, extra: Partial<History> = {}): History => ({
  id, title: `build ${id}`, status: "working", owns: [], planOwns: [], deps: [], planned: true, working: false, events: [], replies: [], ...extra,
});

describe("quietStretches", () => {
  test("finds gaps between replies at least the minimum long", () => {
    expect(quietStretches([0, 5 * MIN, 20 * MIN, 21 * MIN], [], [], 10 * MIN)).toEqual([{ from: 5 * MIN, to: 20 * MIN, open: false }]);
  });

  test("skips a gap that starts right after the worker reported, since it's waiting for the orchestrator", () => {
    expect(quietStretches([0, 60 * MIN], [-MIN], [], 10 * MIN)).toEqual([]);
    expect(quietStretches([0, 60 * MIN], [-30 * MIN], [], 10 * MIN)).toHaveLength(1);
  });

  test("ends a gap when the worker was stopped, and runs on to now while it's still working", () => {
    expect(quietStretches([0, 60 * MIN], [], [15 * MIN], 10 * MIN)).toEqual([{ from: 0, to: 15 * MIN, open: false }]);
    expect(quietStretches([0], [], [], 10 * MIN, 30 * MIN)).toEqual([{ from: 0, to: 30 * MIN, open: true }]);
    expect(quietStretches([0], [], [], 10 * MIN)).toEqual([]);
  });
});

test("duration reads as hours and minutes", () => {
  expect(duration(6 * 60 * MIN + 53 * MIN)).toBe("6h 53m");
  expect(duration(2 * 60 * MIN)).toBe("2h");
  expect(duration(42 * MIN)).toBe("42m");
});

describe("the overnight run", () => {
  const ev = (type: TaskEvent["type"], when: string, note?: string, day = 25): TaskEvent => ({ at: iso(when, day), type, note });
  const log: RunEntry[] = [
    { at: iso("23:19", 24), task: "T5", what: "started", note: "W2" },
    { at: iso("00:44"), task: "T5", what: "nudged", note: "no reply for 20m" },
    { at: iso("08:33"), task: "T5", what: "merged", note: "#79" },
    { at: iso("08:34"), task: "T5", what: "rebase-asked" },
  ];
  const input: TimelineInput = {
    title: "Strata", now: at("08:40"), stallMs: 20 * MIN, approvedAt: at("22:00", 24), log,
    tasks: [
      history("T5", {
        worker: "W2", status: "merged, PR #79", owns: ["Sources/StrataCore/LayerCompositor.swift", "Sources/StrataCore/Fade*"], createdAt: at("23:19", 24), mergedAt: at("08:33"),
        replies: [...busy(at("23:20", 24), at("00:24")), ...busy(at("07:17"), at("07:37"))],
        events: [ev("done", "07:38", "fades and dissolves"), ev("reviewed", "07:41", "approve, round 1, risk low: fine")],
      }),
      history("T6", { planOwns: ["Sources/StrataCore/LayerCompositor.swift", "Sources/StrataCore/Media*"], owns: ["x"], createdAt: at("07:42"), replies: [at("07:43")] }),
      history("T9", { planOwns: ["docs/"], deps: ["T5"] }),
    ],
  };
  const lines = buildTimeline(input);

  test("shows a rebase request the watcher's sync sent", () => {
    expect(lines.find((l) => l.text.startsWith("asked to rebase"))?.text).toBe("asked to rebase");
  });

  test("marks the long quiet stretch and says who waited on it, and why", () => {
    const text = renderTimeline(input, lines, { style: plain });
    expect(text).toContain("W2 · T5: build T5  merged, PR #79");
    expect(text).toContain("  Tue 23:19  started by W2");
    expect(text).toContain("! Wed 00:24  quiet for 6h 53m, until Wed 07:17");
    expect(text).toContain("  Wed 00:24  T6 waited 6h 53m for T5, which shares LayerCompositor.swift");
    expect(text).toContain("  Wed 00:24  T9 waited 6h 53m for T5, which it depends on");
    expect(text).toContain("  Wed 00:44  nudged: no reply for 20m");
    expect(text).toContain("  Wed 07:41  reviewed: approve, round 1, risk low: fine");
    expect(text).toContain("  Wed 08:33  merged PR #79");
    expect(text).not.toContain("\x1b[");
  });

  test("falls back to tasks.json for a start and merge the run log doesn't have", () => {
    const t6 = lines.filter((l) => l.task === "T6").map((l) => l.text);
    expect(t6).toEqual(["started"]);
  });

  test("one task shows its own lines and the waits it was part of", () => {
    const text = renderTimeline(input, lines, { style: plain, only: "T6" });
    expect(text.split("\n").filter((l) => /^[ !] /.test(l))).toEqual([
      "  00:24  T6 waited 6h 53m for T5, which shares LayerCompositor.swift",
      "  07:42  started",
    ]);
  });

  test("a worker that's still quiet shows how long so far, and who is still waiting", () => {
    const now: TimelineInput = { ...input, log: [], tasks: [{ ...input.tasks[0]!, mergedAt: undefined, working: true, replies: [at("00:24")], events: [] }, input.tasks[2]!] };
    const text = renderTimeline(now, buildTimeline(now), { style: plain });
    expect(text).toContain("! Wed 00:24  quiet for 8h 16m so far");
    expect(text).toContain("T9 has waited 8h 16m so far for T5, which it depends on");
  });

  test("colours quiet stretches only for a terminal, and clips long notes to one line", () => {
    const colour = renderTimeline(input, lines, { style: styleFor({ isTTY: true }, {}), width: 60 });
    expect(colour).toContain("\x1b[31mquiet for 6h 53m");
    for (const line of renderTimeline(input, lines, { style: plain, width: 60 }).split("\n").slice(1, -1)) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe("which reports excuse a quiet stretch", () => {
  const ev = (type: TaskEvent["type"], when: string, note: string): TaskEvent => ({ at: iso(when), type, note });
  const quietAfter = (event: TaskEvent) => {
    const input: TimelineInput = { title: "t", now: at("09:00"), stallMs: 20 * MIN, log: [], tasks: [history("T5", { replies: [at("00:24"), at("07:17")], events: [event] })] };
    return buildTimeline(input).some((l) => l.text.startsWith("quiet for 6h 53m"));
  };

  test("a rebase or a proposed decision leaves the worker working, so the gap after it still shows", () => {
    expect(quietAfter(ev("rebased", "00:23", "rebased onto main"))).toBe(true);
    expect(quietAfter(ev("needs-decision", "00:23", "D-17 Fades are stored on the clip"))).toBe(true);
  });

  test("done, blocked or a question for the user hands the work back, so the gap after it is excused", () => {
    expect(quietAfter(ev("done", "00:23", "built fades"))).toBe(false);
    expect(quietAfter(ev("blocked", "00:23", "need the API shape"))).toBe(false);
    expect(quietAfter(ev("needs-decision", "00:23", "D-13's tool needs EditTool.swift; may I own it?"))).toBe(false);
  });
});

test("a task with no owned paths holds up every other task, and the wait says so", () => {
  const input: TimelineInput = {
    title: "t", now: at("09:00"), stallMs: 20 * MIN, approvedAt: at("00:00"), log: [],
    tasks: [history("T1", { owns: [], createdAt: at("00:00"), replies: [at("00:10"), at("02:10")] }), history("T2", { planOwns: ["docs/"], createdAt: at("03:00") })],
  };
  expect(buildTimeline(input).map((l) => l.text)).toContain("T2 waited 2h for T1, which owns every path");
});

test("one task's timeline reads only its own transcripts and those of tasks it could wait on", () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
  try {
    const repo = tempRepo();
    const task = (id: string, owns: string[]): Task => ({ id, status: "running", branch: `foreman/${id}`, base: "main", worktree: join(repo.foreman, "worktrees", id), owns, socket: "", createdAt: iso("00:00") });
    const tasks = [task("T1", ["src/a.ts"]), task("T2", ["src/a.ts", "src/b.ts"]), task("T3", ["docs/"])];
    mkdirSync(repo.foreman, { recursive: true });
    writeJson(join(repo.foreman, "tasks.json"), { tasks });
    for (const t of tasks) {
      recordSession(sessionsFile(repo, t.id), `s-${t.id}`);
      mkdirSync(transcriptDir(t.worktree), { recursive: true });
      writeFileSync(join(transcriptDir(t.worktree), `s-${t.id}.jsonl`), JSON.stringify({ type: "assistant", timestamp: iso("00:05") }) + "\n");
    }
    const input = gatherTimeline(repo, at("01:00"), "T1");
    expect(input.tasks.map((t) => [t.id, t.replies.length])).toEqual([["T1", 1]]);
    writeJson(join(repo.foreman, "plan.json"), { title: "p", tasks: tasks.map((t) => ({ id: t.id, title: `feat: ${t.id}`, owns: t.owns, deps: [], contract: false, brief: "" })) });
    expect(gatherTimeline(repo, at("01:00"), "T1").tasks.map((t) => [t.id, t.replies.length])).toEqual([["T1", 1], ["T2", 1]]);
    expect(() => gatherTimeline(repo, at("01:00"), "T9")).toThrow("no task T9");
  } finally {
    process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("the timeline shows each worker's wait for the usage limit, and one still waiting", () => {
  const log: RunEntry[] = [
    { at: iso("14:00"), task: "T1", what: "paused", note: "usage limit, resets 15:45" },
    { at: iso("15:46"), task: "T1", what: "resumed", note: "the usage limit reset" },
    { at: iso("14:00"), task: "T2", what: "paused", note: "usage limit, resets 15:45" },
  ];
  const input: TimelineInput = { title: "notes", now: at("15:00"), stallMs: 20 * MIN, log, tasks: [history("T1", { createdAt: at("13:00") }), history("T2", { createdAt: at("13:00") })] };
  const text = renderTimeline(input, buildTimeline(input), { style: plain });
  expect(text).toContain("14:00  waited 1h 46m for the usage limit to reset, until 15:46");
  expect(text).toContain("15:46  resumed: the usage limit reset");
  expect(text).toContain("14:00  paused for the usage limit, resets 15:45");
});
