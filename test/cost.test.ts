import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.ts";
import { budgetLeft, lastReplyAt, overBudget, planSpend, priceFor, recordSession, resetBudget, sessionsFile, taskCost, transcriptDir, transcriptSpend, usageCost } from "../src/cost.ts";
import { budgetOverview } from "../src/overview.ts";
import { loadPlan, planPath, type Plan } from "../src/plan.ts";
import type { Repo } from "../src/paths.ts";
import { loadTasks, writeJson, type Task } from "../src/state.ts";
import { tempRepo, writeRound } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));

test("usageCost matches what Claude Code reported for a real review", () => {
  const usage = { input_tokens: 6, output_tokens: 1024, cache_read_input_tokens: 1387674, cache_creation_input_tokens: 23758, cache_creation: { ephemeral_1h_input_tokens: 23758, ephemeral_5m_input_tokens: 0 } };
  expect(usageCost(usage, priceFor("claude-opus-5-5")!)).toBeCloseTo(0.4881028, 6);
});

test("priceFor prefers the longest matching id and takes overrides", () => {
  expect(priceFor("claude-opus-5-5")!.input).toBe(4);
  expect(priceFor("claude-opus-4-8")).toBeUndefined();
  expect(priceFor("claude-opus-4-8", { "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 } })!.input).toBe(5);
});

test("transcriptSpend counts each reply once and only recorded sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-cost-"));
  const reply = (id: string, model = "claude-opus-5-5") => JSON.stringify({ message: { id, model, usage: { input_tokens: 1_000_000 } } });
  writeFileSync(join(dir, "worker-1.jsonl"), [reply("a"), reply("a"), reply("b"), reply("c", "claude-mystery-1")].join("\n"));
  writeFileSync(join(dir, "reviewer-9.jsonl"), reply("z"));
  mkdirSync(join(dir, "worker-1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "worker-1", "subagents", "agent.jsonl"), reply("s"));
  const spend = transcriptSpend(dir, ["worker-1"]);
  expect(spend.usd).toBeCloseTo(12, 6);
  expect(spend.unpriced).toEqual(["claude-mystery-1"]);
});

test("lastReplyAt skips messages queued into an idle session", () => {
  const file = join(mkdtempSync(join(tmpdir(), "foreman-idle-")), "s.jsonl");
  const line = (type: string, timestamp: string) => JSON.stringify({ type, timestamp });
  writeFileSync(file, [line("assistant", "2026-11-25T00:24:24Z"), line("system", "2026-11-25T01:19:26Z"), line("queue-operation", "2026-11-25T07:17:49Z")].join("\n") + "\n");
  expect(lastReplyAt(file)).toBe(Date.parse("2026-11-25T00:24:24Z"));
});

test("overBudget alerts once per limit, and again after the limit is raised", () => {
  const costs = [{ id: "T1", worker: 6, review: 0.5, total: 6.5, unpriced: [] }];
  const first = overBudget(costs, 6.5, { perTask: 5, plan: 6 }, {});
  expect(first.reasons).toEqual(["over-budget T1: $6.50 of $5.00", "over-budget plan: $6.50 of $6.00"]);
  expect(overBudget(costs, 6.5, { perTask: 5, plan: 6 }, first.alerted).reasons).toEqual([]);
  expect(overBudget(costs, 6.5, { perTask: 5, plan: 6, tasks: { T1: 6 } }, first.alerted).reasons).toEqual(["over-budget T1: $6.50 of $6.00"]);
});

test("overBudget names every task to stop on every pass, and every task once the plan is over", () => {
  const costs = [{ id: "T1", worker: 6, review: 0, total: 6, unpriced: [] }, { id: "T2", worker: 1, review: 0, total: 1, unpriced: [] }];
  const first = overBudget(costs, 7, { perTask: 5, plan: 40 }, {});
  expect(first.stop).toEqual(["T1"]);
  expect(overBudget(costs, 7, { perTask: 5, plan: 40 }, first.alerted).stop).toEqual(["T1"]);
  expect(overBudget(costs, 7, { perTask: 5, plan: 6 }, {}).stop).toEqual(["T1", "T2"]);
});

// Every reply is a million input tokens on Opus, so each costs $4.00.
function reply(dir: string, session: string, at: string): void {
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: "assistant", message: { id: `${session}-${at}`, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } }, timestamp: at });
  writeFileSync(join(dir, `${session}.jsonl`), line + "\n", { flag: "a" });
}

// T1 merged under an earlier plan, T2 is in this plan and T3 was spawned outside it once it was approved.
function laterPlan(): Repo {
  const repo = tempRepo();
  const task = (id: string, status: Task["status"], createdAt: string): Task => ({ id, status, branch: `foreman/${id}`, base: "main", worktree: join(repo.root, "wt", id), owns: [id], socket: "", createdAt });
  mkdirSync(repo.foreman, { recursive: true });
  const tasks = [task("T1", "merged", "2026-11-01T09:00:00Z"), task("T2", "running", "2026-11-20T10:05:00Z"), task("T3", "running", "2026-11-20T10:10:00Z")];
  writeJson(join(repo.foreman, "tasks.json"), { tasks });
  for (const [t, at] of [[tasks[0]!, "2026-11-01T10:00:00Z"], [tasks[1]!, "2026-11-20T11:00:00Z"], [tasks[2]!, "2026-11-20T11:00:00Z"]] as const) {
    recordSession(sessionsFile(repo, t.id), `s-${t.id}`);
    reply(transcriptDir(t.worktree), `s-${t.id}`, at);
  }
  recordSession(sessionsFile(repo), "orch");
  reply(transcriptDir(repo.root), "orch", "2026-11-01T09:30:00Z");
  reply(transcriptDir(repo.root), "orch", "2026-11-20T10:30:00Z");
  const plan: Plan = { title: "Tags", approvedAt: "2026-11-20T10:00:00Z", startedAt: "2026-11-20T10:00:00Z", tasks: [{ id: "T2", title: "feat: tags", owns: ["T2"], deps: [], contract: false, brief: "" }] };
  writeJson(planPath(repo), plan);
  saveConfig(repo, { budget: { perTask: 5, plan: 40 } });
  return repo;
}

test("a plan approved after older tasks merged counts only its own tasks and the orchestrator since its approval", () => {
  const repo = laterPlan();
  expect(planSpend(repo, loadTasks(repo))).toBeCloseTo(12, 6);
  expect(budgetOverview(repo)).toStartWith("$12.00 of $40.00 spent");
  expect(budgetOverview(repo)).not.toContain("T1");
  expect(budgetLeft(repo, loadTasks(repo)).usd).toBeCloseTo(28, 6);
});

test("with no plan stored, every task and all of the orchestrator's spend count", () => {
  const repo = laterPlan();
  rmSync(planPath(repo));
  expect(planSpend(repo, loadTasks(repo))).toBeCloseTo(20, 6);
});

test("foreman budget reset puts the plan's count to $0, and the budget, the over-budget check and budgetLeft agree", () => {
  const repo = laterPlan();
  saveConfig(repo, { budget: { perTask: 5, plan: 10 } });
  const before = overBudget(loadTasks(repo).map((t) => taskCost(repo, t)), planSpend(repo, loadTasks(repo)), { perTask: 5, plan: 10 }, {});
  expect(before.reasons).toEqual(["over-budget plan: $12.00 of $10.00"]);
  const t2 = loadTasks(repo)[1]!;
  writeJson(join(repo.foreman, "tasks.json"), { tasks: loadTasks(repo).map((t) => (t.id === "T2" ? { ...t, status: "over-budget", pausedFrom: "running", reviews: 1 } : t)) });
  writeRound(repo, "T2", 1, { reviewer: { total_cost_usd: 0.5 }, at: new Date("2026-11-20T11:30:00Z") });
  const planBefore = loadPlan(repo)!;

  expect(resetBudget(repo, new Date("2026-11-20T12:00:00Z"))).toEqual([
    "The plan's count starts again at $0.00 from now. Its $10.00 limit and every task's limit stay as they are.",
    "T2 stopped because the plan ran over. Ask the orchestrator to resume it.",
  ]);
  const tasks = loadTasks(repo);
  expect(planSpend(repo, tasks)).toBe(0);
  expect(budgetOverview(repo)).toStartWith("$0.00 of $10.00 spent");
  expect(budgetOverview(repo)).toContain("counted since foreman budget reset on");
  expect(budgetLeft(repo, tasks).usd).toBe(10);
  expect(budgetLeft(repo, tasks, "T2").usd).toBeCloseTo(0.5, 6);
  expect(taskCost(repo, t2).total).toBe(4);
  expect(taskCost(repo, loadTasks(repo)[1]!).total).toBeCloseTo(4.5, 6);
  const after = overBudget(tasks.map((t) => taskCost(repo, t)), planSpend(repo, tasks), { perTask: 5, plan: 10 }, before.alerted);
  expect(after).toEqual({ reasons: [], alerted: {}, stop: [] });
  const { budgetResetAt, ...kept } = loadPlan(repo)!;
  expect(budgetResetAt).toBe("2026-11-20T12:00:00.000Z");
  expect(kept).toEqual(planBefore);

  reply(transcriptDir(t2.worktree), "s-T2", "2026-11-20T13:00:00Z");
  reply(transcriptDir(t2.worktree), "s-T2", "2026-11-20T13:10:00Z");
  reply(transcriptDir(repo.root), "orch", "2026-11-20T13:05:00Z");
  const later = loadTasks(repo);
  expect(planSpend(repo, later)).toBeCloseTo(12, 6);
  expect(overBudget(later.map((t) => taskCost(repo, t)), planSpend(repo, later), { perTask: 5, plan: 10 }, after.alerted).reasons).toContain("over-budget plan: $12.00 of $10.00");
});

test("foreman budget reset needs a plan", () => {
  expect(() => resetBudget(tempRepo())).toThrow("no plan.");
});
