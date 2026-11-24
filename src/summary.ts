import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, orchestratorCost, taskCost, usd } from "./cost.ts";
import { lastDone, type TaskEvent } from "./events.ts";
import { loadDecisions, type Decision } from "./ledger.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, type Plan } from "./plan.ts";
import { roundDir, type Verdict } from "./review.ts";
import { loadTasks, type Task } from "./state.ts";

export type Ready = { task: Task; title: string; verdict?: Verdict; done?: TaskEvent; blocks: string[] };
export type Unfinished = { id: string; title: string; reason: string };
export type SummaryInput = {
  title: string; ready: Ready[]; merged: string[]; unfinished: Unfinished[];
  calls: string[]; cut: string[]; open: Decision[]; spent: number; limit?: number;
};

const RISK = { high: 0, medium: 1, low: 2 } as const;
const riskRank = (r: Ready) => RISK[r.verdict?.risk ?? "medium"];
const list = (ids: string[]) => (ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

// PRs other tasks wait on come first, because nothing behind them can start until they merge. Then riskier work, while there's time to fix it.
export function reviewOrder(ready: Ready[]): Ready[] {
  return [...ready].sort((a, b) => b.blocks.length - a.blocks.length || riskRank(a) - riskRank(b));
}

function why(r: Ready): string {
  if (r.blocks.length) return ` - ${list(r.blocks)} ${r.blocks.length === 1 ? "waits" : "wait"} for this, so it goes first`;
  if (r.verdict && r.verdict.risk !== "low") return ` - risk ${r.verdict.risk}, so review it early`;
  return "";
}

export function renderSummary(s: SummaryInput): string {
  const ordered = reviewOrder(s.ready);
  const stuck = s.unfinished.length ? ` ${s.unfinished.length} task(s) not finished.` : "";
  return [
    `# Run summary: ${s.title}`,
    "",
    `${s.ready.length} PR(s) ready, ${usd(s.spent)} spent${s.limit !== undefined ? ` of ${usd(s.limit)}` : ""}.${stuck}`,
    "",
    "## Review in this order",
    "",
    ...(ordered.length ? ordered.flatMap((r, i) => [
      `${i + 1}. **${r.task.pr ? `#${r.task.pr} ` : ""}${r.title}** (${r.task.id})${why(r)}`,
      ...(r.done?.test?.length ? ["   - Test:", ...r.done.test.map((t) => `     - ${t}`)] : ["   - Test: the worker gave no steps"]),
      ...(r.done?.assumptions ?? []).map((a) => `   - Check: ${a}`),
      `   - Risk: ${r.verdict?.risk ?? "not reviewed"}${r.verdict?.risk_note ? `. ${r.verdict.risk_note}` : ""}`,
    ]) : ["Nothing is ready yet."]),
    "",
    ...(s.merged.length ? ["## Already merged", "", list(s.merged), ""] : []),
    ...(s.unfinished.length ? ["## Not finished", "", ...s.unfinished.map((u) => `- **${u.title}** (${u.id}): ${u.reason}`), ""] : []),
    ...(s.calls.length ? ["## Calls Foreman made for you", "", ...s.calls.map((c) => `- ${c}`), ""] : []),
    ...(s.open.length || s.cut.length
      ? ["## Still open", "", ...s.open.map((d) => `- ${d.id}: ${d.title}. Proposed by ${d.by} and not decided yet.`), ...s.cut.map((c) => `- Cut: ${c}`), ""]
      : []),
  ].join("\n");
}

function latestVerdict(repo: Repo, task: Task): Verdict | undefined {
  const file = join(roundDir(repo, task.id, task.reviews ?? 0), "verdict.json");
  return task.reviews && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

const UNFINISHED: Record<string, string> = {
  running: "still being built",
  done: "finished and waiting for review",
  blocked: "blocked, waiting on you",
  "needs-decision": "waiting for a decision",
  exited: "its worker stopped unexpectedly",
};

export function gather(repo: Repo, plan: Plan | undefined): SummaryInput {
  const tasks = loadTasks(repo);
  const titleOf = (id: string) => plan?.tasks.find((t) => t.id === id)?.title ?? lastDone(repo, id)?.note ?? id;
  const merged = tasks.filter((t) => t.mergedAt).map((t) => t.id);
  const ready: Ready[] = [];
  const unfinished: Unfinished[] = [];
  for (const task of tasks.filter((t) => !t.mergedAt && t.status !== "torn-down")) {
    const verdict = latestVerdict(repo, task);
    if (task.pr || (task.status === "done" && verdict?.verdict === "approve")) {
      const blocks = plan?.tasks.filter((p) => p.deps.includes(task.id) && !merged.includes(p.id)).map((p) => p.id) ?? [];
      ready.push({ task, title: titleOf(task.id), verdict, done: lastDone(repo, task.id), blocks });
    } else unfinished.push({ id: task.id, title: titleOf(task.id), reason: UNFINISHED[task.status] ?? task.status });
  }
  for (const p of plan?.tasks ?? []) if (!tasks.some((t) => t.id === p.id)) unfinished.push({ id: p.id, title: p.title, reason: "not started" });
  const spent = tasks.reduce((sum, t) => sum + taskCost(repo, t).total, 0) + orchestratorCost(repo).usd;
  return {
    title: plan?.title ?? "Foreman tasks", ready, merged, unfinished, calls: plan?.calls ?? [], cut: plan?.cut ?? [],
    open: loadDecisions(repo).filter((d) => d.status === "proposed"), spent, limit: budgetOf(repo).plan,
  };
}

export function writeSummary(repo: Repo): string {
  const path = join(repo.foreman, "summary.md");
  writeFileSync(path, renderSummary(gather(repo, loadPlan(repo))));
  return path;
}
