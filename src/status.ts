import { budgetOf, orchestratorCost, taskCost, usd } from "./cost.ts";
import { byActivity, clip, statusLabel, taskTitle } from "./overview.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, maxWorkers, readyTasks, stackable } from "./plan.ts";
import { plainTitle } from "./spawn.ts";
import { loadTasks, type Task } from "./state.ts";
import { activeLimit, resetPhrase } from "./limits.ts";
import type { Style } from "./style.ts";

export type Row = { cells: string[]; tone: (s: Style) => (s: string) => string; toneAt?: number; dim?: boolean };
export type Section = { title: string; rows: Row[] };

const NEEDS_YOU: Task["status"][] = ["needs-decision", "blocked", "exited", "over-budget", "pr-open"];
const finished = (t: Task) => t.status === "torn-down" || t.status === "merged";

function tone(t: Task): Row["tone"] {
  if (t.status === "pr-open") return (s) => s.green;
  if (t.status === "limited") return (s) => s.yellow;
  if (NEEDS_YOU.includes(t.status)) return (s) => s.red;
  if (finished(t)) return (s) => s.dim;
  return (s) => s.cyan;
}

export function statusView(repo: Repo, style: Style, armed: boolean, now = Date.now()): string {
  const tasks = byActivity(loadTasks(repo));
  const plan = loadPlan(repo);
  const row = (t: Task): Row => ({
    cells: [t.id, t.worker ?? "", taskTitle(repo, t, 56), statusLabel(t) + (t.pr ? ` #${t.pr}` : ""), usd(taskCost(repo, t).total)],
    tone: tone(t),
    dim: finished(t),
  });
  const waiting = plan?.approvedAt ? readyTasks(plan, tasks, maxWorkers(repo), stackable(repo)).waiting : [];
  const sections: Section[] = [
    { title: "Needs you", rows: tasks.filter((t) => NEEDS_YOU.includes(t.status)).map(row) },
    { title: "In progress", rows: tasks.filter((t) => !finished(t) && !NEEDS_YOU.includes(t.status)).map(row) },
    {
      title: "Waiting to start",
      rows: waiting.map((w) => ({ cells: [w.id, "", clip(plainTitle(plan!.tasks.find((t) => t.id === w.id)!.title), 56), w.reason, ""], tone: (s: Style) => s.dim })),
    },
    { title: "Finished", rows: tasks.filter(finished).map(row) },
  ].filter((s) => s.rows.length);

  // A run started before workers were numbered has no worker to show, so the empty column goes.
  if (!tasks.some((t) => t.worker)) for (const s of sections) for (const r of s.rows) r.cells.splice(1, 1);

  const budget = budgetOf(repo);
  const spent = tasks.reduce((sum, t) => sum + taskCost(repo, t).total, 0) + orchestratorCost(repo).usd;
  const limit = activeLimit(repo, now);
  const head = [
    ...(plan ? [style.bold(plan.title) + (plan.approvedAt ? "" : style.yellow("  (not approved yet)"))] : []),
    ...(plan?.deadline ? [style.dim(`Deadline: ${plan.deadline}`)] : []),
    [
      armed ? style.green("Watcher on") : style.red("Watcher off, so nothing will wake the orchestrator"),
      budget.plan !== undefined ? `${usd(spent)} of ${usd(budget.plan)} spent` : `${usd(spent)} spent`,
    ].join(style.dim("  ·  ")),
    ...(limit ? [style.yellow(`Waiting for the usage limit to reset at ${resetPhrase(limit, now)}. Workers are paused, and no task or review starts until then.`)] : []),
  ];
  const body = sectionLines(sections, style, (r) => [r.cells.length - 1]);
  return [...head, ...(tasks.length || waiting.length ? body : ["", "No tasks yet."])].join("\n");
}

// Every section shares one set of column widths, so the rows line up down the whole page.
export function sectionLines(sections: Section[], style: Style, rightAligned: (r: Row) => number[]): string[] {
  const all = sections.flatMap((s) => s.rows.map((r) => r.cells));
  const widths = all.length ? all[0]!.map((_, i) => Math.max(...all.map((c) => (c[i] ?? "").length))) : [];
  const line = (r: Row) => {
    const right = rightAligned(r);
    const toneAt = r.toneAt ?? r.cells.length - 2;
    const cells = r.cells.map((c, i) => (right.includes(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)));
    // Nested colour codes reset each other, so a dimmed row is dimmed as a whole and nothing else.
    if (r.dim) return `  ${style.dim(cells.join("  ").trimEnd())}`;
    return `  ${cells.map((c, i) => (i === 0 ? style.bold(c) : i === toneAt ? r.tone(style)(c) : c)).join("  ").trimEnd()}`;
  };
  return sections.flatMap((s) => ["", style.heading(s.title), ...s.rows.map(line)]);
}
