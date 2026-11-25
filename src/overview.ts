import { loadConfig } from "./config.ts";
import { budgetOf, orchestratorCost, taskCost, taskLimit, usd } from "./cost.ts";
import type { Repo } from "./paths.ts";
import { loadPlan } from "./plan.ts";
import { plainTitle } from "./spawn.ts";
import { loadTasks, type Task } from "./state.ts";
import { sectionLines, type Row, type Section } from "./status.ts";
import { PLAIN, type Style } from "./style.ts";

const TITLE_WIDTH = 44;

const MODEL_WIDTH = 14;

// Capped, so a provider id like "arn:aws:bedrock:...:inference-profile/..." can't squeeze the title out of the table.
export function shortModel(model: string): string {
  const id = model.match(/claude-([a-z]+)-(\d+)-(\d+)/);
  const short = id ? `${id[1]} ${id[2]}.${id[3]}` : model;
  return short.length > MODEL_WIDTH ? short.slice(0, MODEL_WIDTH - 3) + "..." : short;
}

// A model other than workerModel goes beside the title, since it explains why the task cost more or less than the rest.
export function taskTitle(repo: Repo, task: Task, width = TITLE_WIDTH): string {
  const title = task.title ?? loadPlan(repo)?.tasks.find((t) => t.id === task.id)?.title;
  const model = task.model && task.model !== loadConfig(repo).workerModel ? `(${shortModel(task.model)})` : "";
  if (!title) return model;
  return [clip(plainTitle(title), width - (model ? model.length + 1 : 0)), model].filter(Boolean).join(" ");
}

export const clip = (s: string, width: number) => (s.length > width ? s.slice(0, width - 3).trimEnd() + "..." : s);

// The stored statuses are Foreman's own lifecycle words, so the tables say what each one means for the user.
export function statusLabel(task: Task): string {
  switch (task.status) {
    case "running": return "working";
    case "over-budget": return "stopped, over budget";
    case "limited": return "paused for the usage limit";
    case "done": return "finished, in review";
    case "needs-decision": return "needs a decision";
    case "exited": return "worker closed";
    case "pr-open": return task.mergedInto ? `PR merged into ${task.mergedInto}` : task.prClosed ? "PR closed" : "PR open";
    case "torn-down": return task.mergedAt ? "merged" : "discarded";
    default: return task.status;
  }
}

export function table(rows: string[][], rightAligned: number[] = []): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (rightAligned.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

// Finished tasks still count towards the plan, but the ones still being built are what the reader acts on.
export function byActivity(tasks: Task[]): Task[] {
  const finished = (t: Task) => t.status === "torn-down" || t.status === "merged";
  return [...tasks.filter((t) => !finished(t)), ...tasks.filter(finished)];
}

const BAR = 12;

// The bar shows spend against a limit at a glance, turning yellow near the limit and red past it.
export function bar(spent: number, limit: number | undefined, style: Style): string {
  if (limit === undefined || limit <= 0) return "";
  const share = spent / limit;
  const filled = Math.min(BAR, Math.round(share * BAR));
  const tone = share > 1 ? style.red : share >= 0.75 ? style.yellow : style.green;
  return tone("█".repeat(filled)) + style.dim("░".repeat(BAR - filled));
}

export function budgetOverview(repo: Repo, style: Style = PLAIN, change = "Change a limit with foreman budget <usd> for every task, foreman budget <task> <usd> for one, or foreman budget --plan <usd>."): string {
  const budget = budgetOf(repo);
  const tasks = byActivity(loadTasks(repo));
  const costs = new Map(tasks.map((t) => [t.id, taskCost(repo, t)]));
  const orch = orchestratorCost(repo);
  const spent = [...costs.values()].reduce((s, c) => s + c.total, 0) + orch.usd;
  const done = (t: Task) => t.status === "torn-down" || t.status === "merged";
  const numbered = tasks.some((t) => t.worker);
  const row = (t: Task): Row => {
    const limit = taskLimit(budget, t.id);
    const cells = [t.id, ...(numbered ? [t.worker ?? ""] : []), taskTitle(repo, t, 56), usd(costs.get(t.id)!.total), limit !== undefined ? `of ${usd(limit)}` : "no limit"];
    return { cells: done(t) ? cells : [...cells.slice(0, -1), `${cells.at(-1)!}  ${bar(costs.get(t.id)!.total, limit, style)}`], tone: () => (s: string) => s, dim: done(t) };
  };
  const sections: Section[] = [
    { title: "In progress", rows: tasks.filter((t) => !done(t)).map(row) },
    { title: "Finished", rows: tasks.filter(done).map(row) },
    { title: "Foreman itself", rows: [{ cells: ["", ...(numbered ? [""] : []), "The orchestrator", usd(orch.usd), ""], tone: () => (s: string) => s }] },
  ].filter((s) => s.rows.length);
  const spentAt = numbered ? 3 : 2;
  const plan = budget.plan !== undefined
    ? [`${style.bold(usd(spent))} of ${usd(budget.plan)} spent  ${bar(spent, budget.plan, style)}`, style.dim(`${usd(Math.max(0, budget.plan - spent))} left for the plan, at list prices`)]
    : [`${style.bold(usd(spent))} spent, with no plan limit`, style.dim("At list prices")];
  const unpriced = [...new Set([...[...costs.values()].flatMap((c) => c.unpriced), ...orch.unpriced])];
  return [
    ...plan,
    ...sectionLines(sections, style, () => [spentAt]),
    "",
    ...(unpriced.length ? [style.yellow(`Not counted: ${unpriced.join(", ")} has no price. Add it under "prices" in .foreman/config.json`), ""] : []),
    style.dim(change),
  ].join("\n");
}
