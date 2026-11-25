import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { taskDir, type Repo } from "./paths.ts";
import type { Task } from "./state.ts";

export type Issue = { where: string; screenshot?: string; intent: string; problem: string; expected: string };
export type PrDraft = { title: string; description: string };
export type Verdict = { verdict: "approve" | "changes"; summary: string; issues: Issue[]; risk: "low" | "medium" | "high"; risk_note: string; decisions_touched: string[]; pr?: PrDraft };
export type Shot = { name: string; before?: string; after?: string };

// finishedAt is when reviewer.json was written, which is when the round's spend landed.
export type Round = { n: number; dir: string; verdict?: Verdict; costUsd: number; finishedAt?: number; models: string[]; output?: string; shots: Shot[] };

export const roundDir = (repo: Repo, id: string, n: number) => join(taskDir(repo, id), "review", `round-${n}`);

export const roundFiles = (dir: string) => ({
  prompt: join(dir, "prompt.md"),
  diff: join(dir, "diff.patch"),
  reviewer: join(dir, "reviewer.json"),
  verdict: join(dir, "verdict.json"),
  feedback: join(dir, "feedback.md"),
  before: join(dir, "before"),
  after: join(dir, "after"),
});

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

function parse<T>(text: string | undefined): T | undefined {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function shotsIn(files: ReturnType<typeof roundFiles>): Shot[] {
  const names = new Set<string>();
  for (const side of [files.before, files.after]) if (existsSync(side)) for (const f of readdirSync(side)) if (f.endsWith(".png")) names.add(f.slice(0, -4));
  return [...names].sort().map((name) => {
    const at = (side: string) => (existsSync(join(side, `${name}.png`)) ? join(side, `${name}.png`) : undefined);
    return { name, before: at(files.before), after: at(files.after) };
  });
}

function round(repo: Repo, id: string, n: number): Round {
  const dir = roundDir(repo, id, n);
  const files = roundFiles(dir);
  const output = read(files.reviewer);
  const reviewer = parse<{ total_cost_usd?: number; modelUsage?: Record<string, unknown> }>(output);
  return {
    n, dir, verdict: parse<Verdict>(read(files.verdict)), costUsd: reviewer?.total_cost_usd ?? 0,
    ...(output !== undefined ? { finishedAt: statSync(files.reviewer).mtimeMs, output } : {}),
    models: Object.keys(reviewer?.modelUsage ?? {}), shots: shotsIn(files),
  };
}

export function rounds(repo: Repo, task: Pick<Task, "id" | "reviews">): Round[] {
  return Array.from({ length: task.reviews ?? 0 }, (_, i) => round(repo, task.id, i + 1));
}

// The round the task's review count points at, which has no verdict while it runs or when it failed.
export function latest(repo: Repo, task: Pick<Task, "id" | "reviews">): Round | undefined {
  return task.reviews ? round(repo, task.id, task.reviews) : undefined;
}
