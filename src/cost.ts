import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { loadConfig } from "./config.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, planPath, type Plan } from "./plan.ts";
import { rounds } from "./rounds.ts";
import { loadTasks, writeJson, type Task } from "./state.ts";

// Dollars per million tokens at list price; other models go in config.json's "prices". Cache writes cost 1.25x input for 5 minutes and 2x for an hour.
export type Price = { input: number; output: number; cacheRead: number };
export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export type Usage = {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

export function priceFor(model: string, overrides: Record<string, Price> = {}): Price | undefined {
  const key = Object.keys({ ...PRICES, ...overrides }).sort((a, b) => b.length - a.length).find((k) => model.startsWith(k));
  return key ? (overrides[key] ?? PRICES[key]) : undefined;
}

export function usageCost(u: Usage, p: Price): number {
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMin = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - hour);
  const tokens = (u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead
    + fiveMin * p.input * 1.25 + hour * p.input * 2;
  return tokens / 1_000_000;
}

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
export const transcriptDir = (cwd: string) => join(projectsDir(), cwd.replace(/[^A-Za-z0-9-]/g, "-"));

export function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? jsonlFiles(path) : f.endsWith(".jsonl") ? [path] : [];
  });
}

export type Spend = { usd: number; unpriced: string[] };

// Reviewers share the worker's folder and the user's own sessions share the repo's, so only recorded sessions count.
export const sessionsFile = (repo: Repo, taskId?: string) => (taskId ? join(repo.foreman, "tasks", taskId, "sessions") : join(repo.foreman, "orchestrator-sessions"));

export function recordSession(file: string, id: string): void {
  if (loadSessions(file).includes(id)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, id + "\n");
}

export const loadSessions = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

// Claude Code writes one line per content block, each repeating the reply's usage, so replies are counted once by id.
export function transcriptSpend(dir: string, sessions: string[], overrides: Record<string, Price> = {}, since?: number): Spend {
  const replies = new Map<string, { model: string; usage: Usage }>();
  for (const file of jsonlFiles(dir).filter((f) => sessions.some((s) => f.includes(s)))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        if (since !== undefined && !(Date.parse(entry.timestamp) >= since)) continue;
        const m = entry.message;
        if (m?.id && m.usage && m.model) replies.set(m.id, { model: m.model, usage: m.usage });
      } catch {}
    }
  }
  const spend: Spend = { usd: 0, unpriced: [] };
  for (const { model, usage } of replies.values()) {
    const p = priceFor(model, overrides);
    if (p) spend.usd += usageCost(usage, p);
    else if (!model.startsWith("<") && !spend.unpriced.includes(model)) spend.unpriced.push(model);
  }
  return spend;
}

export function reviewSpend(repo: Repo, task: Task, since?: number): number {
  return rounds(repo, task).filter((r) => since === undefined || (r.finishedAt ?? -Infinity) >= since).reduce((sum, r) => sum + r.costUsd, 0);
}

export type TaskCost = { id: string; worker: number; review: number; total: number; unpriced: string[] };

export function taskCost(repo: Repo, task: Task, since?: number): TaskCost {
  const worker = transcriptSpend(transcriptDir(task.worktree), loadSessions(sessionsFile(repo, task.id)), loadConfig(repo).prices, since);
  const review = reviewSpend(repo, task, since);
  return { id: task.id, worker: worker.usd, review, total: worker.usd + review, unpriced: worker.unpriced };
}

function workerTranscripts(repo: Repo, task: Task): string[] {
  const sessions = loadSessions(sessionsFile(repo, task.id));
  return jsonlFiles(transcriptDir(task.worktree)).filter((f) => sessions.some((s) => f.includes(s)));
}

// Only the model's own replies count, since a nudge queued into an idle session also writes to its transcript.
export function lastActivity(repo: Repo, task: Task): number | undefined {
  const known = workerTranscripts(repo, task).map(lastReplyAt).filter((t): t is number => t !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

export const workerReplies = (repo: Repo, task: Task): number[] => workerTranscripts(repo, task).flatMap((f) => replyTimes(f));

// Claude Code writes the line's own timestamp after its message, so the last one is the reply's even when a tool input carries its own.
function replyAt(line: string): number | undefined {
  if (!line.includes('"type":"assistant"')) return undefined;
  const start = line.lastIndexOf('"timestamp":"');
  if (start < 0) return undefined;
  const at = Date.parse(line.slice(start + 13, line.indexOf('"', start + 13)));
  return Number.isNaN(at) ? undefined : at;
}

// Read in chunks, because a transcript can run to hundreds of megabytes and only its reply timestamps are needed.
export function replyTimes(file: string, chunk = 1 << 20): number[] {
  const times: number[] = [];
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.alloc(chunk);
  const fd = openSync(file, "r");
  let rest = "";
  const take = (line: string) => {
    const at = replyAt(line);
    if (at !== undefined) times.push(at);
  };
  try {
    for (let n; (n = readSync(fd, buf, 0, chunk, null)) > 0; ) {
      const lines = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = lines.pop()!;
      lines.forEach(take);
    }
  } finally {
    closeSync(fd);
  }
  take(rest + decoder.end());
  return times;
}

const TAIL_BYTES = 512 * 1024;

export function lastReplyAt(file: string): number | undefined {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
  try {
    readSync(fd, buf, 0, buf.length, size - buf.length);
  } finally {
    closeSync(fd);
  }
  for (const line of buf.toString("utf8").split("\n").reverse()) {
    const at = replyAt(line);
    if (at !== undefined) return at;
  }
  return undefined;
}

export function orchestratorCost(repo: Repo, since?: number): Spend {
  return transcriptSpend(transcriptDir(repo.root), loadSessions(sessionsFile(repo)), loadConfig(repo).prices, since);
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

export type Budget = { perTask?: number; plan?: number; tasks?: Record<string, number> };
export const DEFAULT_BUDGET: Budget = { perTask: 5, plan: 40 };

export const budgetOf = (repo: Repo): Budget => ({ ...DEFAULT_BUDGET, ...loadConfig(repo).budget });

export const taskLimit = (b: Budget | undefined, id: string) => b?.tasks?.[id] ?? b?.perTask;

// Alerts fire once per limit, so a raised limit can alert again, and so can a plan that a reset brought back under its limit. Stop lists every task over its limit on every pass.
export function overBudget(costs: TaskCost[], planTotal: number, budget: Budget | undefined, alerted: Record<string, number>): { reasons: string[]; alerted: Record<string, number>; stop: string[] } {
  const next = { ...alerted };
  const reasons: string[] = [];
  const stop: string[] = [];
  for (const c of costs) {
    const limit = taskLimit(budget, c.id);
    if (limit === undefined || c.total <= limit) continue;
    stop.push(c.id);
    if (next[c.id] !== limit) {
      reasons.push(`over-budget ${c.id}: ${usd(c.total)} of ${usd(limit)}`);
      next[c.id] = limit;
    }
  }
  if (budget?.plan !== undefined && planTotal > budget.plan) {
    stop.push(...costs.map((c) => c.id).filter((id) => !stop.includes(id)));
    if (next["plan"] !== budget.plan) {
      reasons.push(`over-budget plan: ${usd(planTotal)} of ${usd(budget.plan)}`);
      next["plan"] = budget.plan;
    }
  } else delete next["plan"];
  return { reasons, alerted: next, stop };
}

// Tasks spawned outside the plan join it while it runs, and a draft plan counts nothing until it's approved. With no plan at all, everything counts.
export type PlanCount = { since?: number; resetAt?: number; counts: (t: Task) => boolean };

export function planCount(plan: Plan | undefined): PlanCount {
  if (!plan) return { counts: () => true };
  const ids = new Set(plan.tasks.map((t) => t.id));
  const start = Date.parse(plan.startedAt ?? plan.approvedAt ?? "");
  const reset = Date.parse(plan.budgetResetAt ?? "");
  const resetAt = Number.isNaN(reset) ? undefined : reset;
  if (Number.isNaN(start)) return { since: Infinity, resetAt, counts: (t) => ids.has(t.id) };
  return { since: Math.max(start, resetAt ?? start), resetAt, counts: (t) => ids.has(t.id) || Date.parse(t.createdAt) >= start };
}

export type PlanSpend = { usd: number; tasks: TaskCost[]; orchestrator: Spend } & PlanCount;

export function planSpending(repo: Repo, tasks: Task[]): PlanSpend {
  const count = planCount(loadPlan(repo));
  const costs = tasks.filter(count.counts).map((t) => taskCost(repo, t, count.since));
  const orchestrator = orchestratorCost(repo, count.since);
  return { ...count, usd: costs.reduce((sum, c) => sum + c.total, 0) + orchestrator.usd, tasks: costs, orchestrator };
}

export const planSpend = (repo: Repo, tasks: Task[]): number => planSpending(repo, tasks).usd;

// Stored on the plan, so the next plan starts its own count without one.
export function resetBudget(repo: Repo, now = new Date()): string[] {
  const plan = loadPlan(repo);
  if (!plan) throw new Error("no plan. foreman budget reset starts the current plan's count again, and the orchestrator stores a plan with the plan tool");
  writeJson(planPath(repo), { ...plan, budgetResetAt: now.toISOString() });
  const budget = budgetOf(repo);
  const tasks = loadTasks(repo);
  const resumable = tasks.filter((t) => t.status === "over-budget" && !budgetLeft(repo, tasks, t.id).reason).map((t) => t.id);
  return [
    `The plan's count starts again at $0.00 from now. ${budget.plan !== undefined ? `Its ${usd(budget.plan)} limit and every task's limit stay as they are.` : "Every task's limit stays as it is."}`,
    ...(resumable.length ? [`${resumable.join(", ")} stopped because the plan ran over. Ask the orchestrator to resume ${resumable.length === 1 ? "it" : "them"}.`] : []),
  ];
}

export function budgetLeft(repo: Repo, tasks: Task[], id?: string): { usd?: number; reason?: string } {
  const budget = budgetOf(repo);
  const spent = planSpend(repo, tasks);
  if (budget.plan !== undefined && spent >= budget.plan) {
    return { usd: 0, reason: `the plan has spent ${usd(spent)} of its ${usd(budget.plan)} budget. Ask the user whether to raise it, then call set_budget. The user can also start the plan's count again with foreman budget reset` };
  }
  const planLeft = budget.plan === undefined ? undefined : budget.plan - spent;
  const task = id ? tasks.find((t) => t.id === id) : undefined;
  const limit = id ? taskLimit(budget, id) : undefined;
  if (!task || limit === undefined) return { usd: planLeft };
  const taskSpent = taskCost(repo, task).total;
  if (taskSpent >= limit) return { usd: 0, reason: `${id} has spent ${usd(taskSpent)} of its ${usd(limit)} budget. Ask the user whether to raise it, then call set_budget` };
  return { usd: Math.min(limit - taskSpent, planLeft ?? Infinity) };
}

export function costText(repo: Repo): string {
  const budget = budgetOf(repo);
  const tasks = loadTasks(repo);
  const costs = tasks.map((t) => taskCost(repo, t));
  const orch = orchestratorCost(repo);
  const lines = costs.map((c, i) => {
    const limit = taskLimit(budget, c.id);
    const model = tasks[i]!.model;
    return `${c.id.padEnd(8)} ${usd(c.total).padStart(8)}  worker ${usd(c.worker)}${model ? ` on ${model}` : ""}, reviews ${usd(c.review)}${limit !== undefined ? `, limit ${usd(limit)}` : ""}`;
  });
  const total = costs.reduce((s, c) => s + c.total, 0) + orch.usd;
  const plan = planSpending(repo, tasks);
  lines.push(`${"foreman".padEnd(8)} ${usd(orch.usd).padStart(8)}  orchestrator`);
  lines.push(`${"total".padEnd(8)} ${usd(total).padStart(8)}  at list prices`);
  lines.push(`${"plan".padEnd(8)} ${usd(plan.usd).padStart(8)}${budget.plan !== undefined ? `  of ${usd(budget.plan)}` : ""}  ${countedText(plan)}`);
  const unpriced = [...new Set([...costs.flatMap((c) => c.unpriced), ...orch.unpriced])];
  if (unpriced.length) lines.push(`not counted: ${unpriced.join(", ")} has no price. Add it under "prices" in .foreman/config.json`);
  return lines.join("\n");
}

export const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function countedText(count: PlanCount): string {
  if (count.since === undefined) return "counting every task, since there's no plan";
  if (count.since === Infinity) return "counting from when the plan is approved";
  return count.since === count.resetAt ? `counted since foreman budget reset on ${when(count.since)}` : `counted since the plan was approved on ${when(count.since)}`;
}
