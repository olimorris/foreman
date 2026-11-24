import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import type { Repo } from "./paths.ts";
import { roundDir } from "./review.ts";
import type { Task } from "./state.ts";

// Dollars per million tokens at list price; other models go in config.json's "prices". Cache writes cost 1.25x input for 5 minutes and 2x for an hour.
export type Price = { input: number; output: number; cacheRead: number };
export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
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

function jsonlFiles(dir: string): string[] {
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
export function transcriptSpend(dir: string, sessions: string[], overrides: Record<string, Price> = {}): Spend {
  const replies = new Map<string, { model: string; usage: Usage }>();
  for (const file of jsonlFiles(dir).filter((f) => sessions.some((s) => f.includes(s)))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      try {
        const m = JSON.parse(line).message;
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

export function reviewSpend(repo: Repo, task: Task): number {
  let usd = 0;
  for (let r = 1; r <= (task.reviews ?? 0); r++) {
    try {
      usd += JSON.parse(readFileSync(join(roundDir(repo, task.id, r), "reviewer.json"), "utf8")).total_cost_usd ?? 0;
    } catch {}
  }
  return usd;
}

export type TaskCost = { id: string; worker: number; review: number; total: number; unpriced: string[] };

export function taskCost(repo: Repo, task: Task): TaskCost {
  const worker = transcriptSpend(transcriptDir(task.worktree), loadSessions(sessionsFile(repo, task.id)), loadConfig(repo).prices);
  const review = reviewSpend(repo, task);
  return { id: task.id, worker: worker.usd, review, total: worker.usd + review, unpriced: worker.unpriced };
}

export function orchestratorCost(repo: Repo): Spend {
  return transcriptSpend(transcriptDir(repo.root), loadSessions(sessionsFile(repo)), loadConfig(repo).prices);
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

export type Budget = { perTask?: number; plan?: number; tasks?: Record<string, number> };
export const DEFAULT_BUDGET: Budget = { perTask: 5, plan: 40 };

export const budgetOf = (repo: Repo): Budget => ({ ...DEFAULT_BUDGET, ...loadConfig(repo).budget });

export const taskLimit = (b: Budget | undefined, id: string) => b?.tasks?.[id] ?? b?.perTask;

// One line per limit crossed, each only once per limit, so a raised limit can alert again.
export function overBudget(costs: TaskCost[], planTotal: number, budget: Budget | undefined, alerted: Record<string, number>): { reasons: string[]; alerted: Record<string, number> } {
  const next = { ...alerted };
  const reasons: string[] = [];
  for (const c of costs) {
    const limit = taskLimit(budget, c.id);
    if (limit !== undefined && c.total > limit && next[c.id] !== limit) {
      reasons.push(`over-budget ${c.id}: ${usd(c.total)} of ${usd(limit)}`);
      next[c.id] = limit;
    }
  }
  if (budget?.plan !== undefined && planTotal > budget.plan && next["plan"] !== budget.plan) {
    reasons.push(`over-budget plan: ${usd(planTotal)} of ${usd(budget.plan)}`);
    next["plan"] = budget.plan;
  }
  return { reasons, alerted: next };
}
