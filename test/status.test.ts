import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config.ts";
import { planSpend, resetBudget } from "../src/cost.ts";
import { recordSession, sessionsFile, transcriptDir } from "../src/transcripts.ts";
import { budgetOverview } from "../src/overview.ts";
import { gatherPane, spendByTask } from "../src/pane.ts";
import { gather } from "../src/summary.ts";
import { loadPlan, planPath } from "../src/plan.ts";
import { loadTasks } from "../src/state.ts";
import { ensureForeman } from "../src/paths.ts";
import { saveLimit } from "../src/limits.ts";
import { statusView } from "../src/status.ts";
import { PLAIN } from "../src/style.ts";
import { tempRepo } from "./helpers.ts";
import { recordBlocks } from "../src/permissions.ts";

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

test("status lists open permission blocks under Needs you, with the rule that would allow each one", () => {
  const repo = tempRepo();
  ensureForeman(repo);
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task("T5", "running", { worker: "W2" }), task("T6", "running", { worker: "W3" })] }));
  recordBlocks(repo, [
    { role: "worker", task: "T5", worker: "W2", id: "x1", at: "", kind: "auto-mode", tool: "Bash", target: "gh pr merge 41", rule: "Bash(gh pr merge *)" },
    { role: "orchestrator", id: "o1", at: "", kind: "prompt", tool: "Bash", target: "gh run list", rule: "Bash(gh run list *)" },
  ]);
  const lines = statusView(repo, PLAIN, true).split("\n");
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(lines[at("Needs you") + 1]).toMatch(/^ +The orchestrator +waiting at a permission prompt$/);
  expect(lines[at("Needs you") + 2]).toBe("          waiting at a permission prompt to run `gh run list`");
  expect(lines[at("  T5")]).toMatch(/^  T5  W2  build T5 +needs a permission +\$0\.00$/);
  expect(lines[at("  T5") + 1]).toBe("          blocked from running `gh pr merge 41` by auto mode, allow it with Bash(gh pr merge *)");
  expect(at("  T5")).toBeLessThan(at("In progress"));
  expect(at("In progress")).toBeLessThan(at("  T6"));
});

test("after foreman budget reset, status, the pane and the summary show the same spend as foreman budget", () => {
  const repo = tempRepo();
  mkdirSync(repo.foreman, { recursive: true });
  const worktree = join(repo.root, "wt", "T2");
  writeFileSync(join(repo.foreman, "tasks.json"), JSON.stringify({ tasks: [task("T2", "running", { worktree, createdAt: "2026-11-20T10:05:00Z" })] }));
  writeFileSync(planPath(repo), JSON.stringify({ title: "Tags", approvedAt: "2026-11-20T10:00:00Z", startedAt: "2026-11-20T10:00:00Z", tasks: [{ id: "T2", title: "feat: tags", owns: [], deps: [], contract: false, brief: "" }] }));
  saveConfig(repo, { budget: { perTask: 50, plan: 40 } });
  recordSession(sessionsFile(repo, "T2"), "s-T2");
  mkdirSync(transcriptDir(worktree), { recursive: true });
  const reply = (at: string) => JSON.stringify({ type: "assistant", message: { id: at, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } }, timestamp: at }) + "\n";
  writeFileSync(join(transcriptDir(worktree), "s-T2.jsonl"), reply("2026-11-20T11:00:00Z") + reply("2026-11-20T13:00:00Z"));
  const shown = () => {
    const tasks = loadTasks(repo);
    return {
      budget: budgetOverview(repo).split(" ")[0],
      status: statusView(repo, PLAIN, false).split("\n").find((l) => l.includes("spent"))!.match(/\$[\d.]+(?= of)/)![0],
      pane: gatherPane(repo, Date.now(), spendByTask(repo)).spent,
      summary: gather(repo, loadPlan(repo)).spent,
      plan: planSpend(repo, tasks),
    };
  };

  expect(shown()).toEqual({ budget: "$8.00", status: "$8.00", pane: 8, summary: 8, plan: 8 });
  resetBudget(repo, new Date("2026-11-20T12:00:00Z"));
  expect(shown()).toEqual({ budget: "$4.00", status: "$4.00", pane: 4, summary: 4, plan: 4 });
  resetBudget(repo, new Date("2026-11-21T12:00:00Z"));
  expect(shown()).toEqual({ budget: "$0.00", status: "$0.00", pane: 0, summary: 0, plan: 0 });
});
