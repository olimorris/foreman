import { budgetOf, orchestratorCost, taskCost, taskLimit, usd } from "./cost.ts";
import type { Repo } from "./paths.ts";
import { loadPlan } from "./plan.ts";
import { plainTitle } from "./spawn.ts";
import { loadTasks, type Task } from "./state.ts";

const TITLE_WIDTH = 44;

export function taskTitle(repo: Repo, task: Task): string {
  const title = task.title ?? loadPlan(repo)?.tasks.find((t) => t.id === task.id)?.title;
  if (!title) return "";
  const plain = plainTitle(title);
  return plain.length > TITLE_WIDTH ? plain.slice(0, TITLE_WIDTH - 3).trimEnd() + "..." : plain;
}

// The stored statuses are Foreman's own lifecycle words, so the tables say what each one means for the user.
export function statusLabel(task: Task): string {
  switch (task.status) {
    case "running": return "working";
    case "over-budget": return "stopped, over budget";
    case "done": return "finished, in review";
    case "needs-decision": return "needs a decision";
    case "exited": return "worker closed";
    case "pr-open": return "PR open";
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

export function budgetOverview(repo: Repo): string {
  const budget = budgetOf(repo);
  const tasks = byActivity(loadTasks(repo));
  const costs = new Map(tasks.map((t) => [t.id, taskCost(repo, t)]));
  const orch = orchestratorCost(repo);
  const spent = [...costs.values()].reduce((s, c) => s + c.total, 0) + orch.usd;
  const plan = budget.plan !== undefined ? `${usd(spent)} of ${usd(budget.plan)} spent, ${usd(Math.max(0, budget.plan - spent))} left` : `${usd(spent)} spent, no plan limit`;
  const rows = [
    ["Task", "What it builds", "Status", "Spent", "Limit"],
    ...tasks.map((t) => {
      const limit = taskLimit(budget, t.id);
      return [t.id, taskTitle(repo, t), statusLabel(t), usd(costs.get(t.id)!.total), limit !== undefined ? usd(limit) : "none"];
    }),
    ["", "Foreman itself", "", usd(orch.usd), ""],
  ];
  const unpriced = [...new Set([...[...costs.values()].flatMap((c) => c.unpriced), ...orch.unpriced])];
  return [
    `Plan: ${plan}, at list prices`,
    "",
    ...table(rows, [3, 4]),
    "",
    ...(unpriced.length ? [`Not counted: ${unpriced.join(", ")} has no price. Add it under "prices" in .foreman/config.json`, ""] : []),
    "Change a limit with foreman budget <usd> for every task, foreman budget <task> <usd> for one, or foreman budget --plan <usd>.",
  ].join("\n");
}
