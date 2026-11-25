import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureForeman } from "../src/spawn.ts";
import { saveLimit } from "../src/limits.ts";
import { statusView } from "../src/status.ts";
import { PLAIN } from "../src/style.ts";
import { tempRepo } from "./helpers.ts";

const task = (id: string, status: string, extra: object = {}) => ({ id, status, title: `feat: build ${id}`, branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, owns: [], socket: "", createdAt: "", ...extra });

test("status groups tasks by what they need from the user", () => {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [
    task("T1", "torn-down", { mergedAt: "x", pr: 4, worker: "W1" }),
    task("T2", "running", { worker: "W1" }),
    task("T3", "needs-decision", { worker: "W2" }),
  ] }));
  const lines = statusView(repo, PLAIN, false).split("\n");
  expect(lines[0]).toBe("Watcher off, so nothing will wake the orchestrator  ·  $0.00 of $40.00 spent");
  const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
  expect(at("Needs you")).toBeLessThan(at("  T3"));
  expect(at("  T3")).toBeLessThan(at("In progress"));
  expect(at("In progress")).toBeLessThan(at("  T2"));
  expect(at("Finished")).toBeLessThan(at("  T1"));
  expect(lines[at("  T1")]).toMatch(/^  T1  W1  build T1 +merged #4 +\$0\.00$/);
});

test("status says work waits for the usage limit, and when it resets", () => {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task("T2", "limited", { worker: "W1" }), task("T3", "done", { worker: "W2" })] }));
  const now = new Date(2026, 10, 25, 14, 0).getTime();
  saveLimit(repo, { since: now, resetsAt: new Date(2026, 10, 25, 15, 45).getTime(), by: "T2", paused: ["T2"], announced: true });
  const lines = statusView(repo, PLAIN, true, now).split("\n");
  expect(lines[1]).toBe("Waiting for the usage limit to reset at 15:45. Workers are paused, and no task or review starts until then.");
  expect(lines.find((l) => l.startsWith("  T2"))).toContain("paused for the usage limit");
  expect(statusView(repo, PLAIN, true, new Date(2026, 10, 25, 16, 0).getTime())).not.toContain("Waiting for the usage limit");
});
