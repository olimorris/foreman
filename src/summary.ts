import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, orchestratorCost, taskCost, usd } from "./cost.ts";
import { lastDone, type TaskEvent } from "./events.ts";
import { loadDecisions, type Decision } from "./ledger.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, type Plan } from "./plan.ts";
import { loadQuestions, type Question } from "./questions.ts";
import { latestVerdict, type Verdict } from "./review.ts";
import { loadTasks, type Task } from "./state.ts";
import { run } from "./exec.ts";
import { loadTogether, renderTogether, staleness, type Together } from "./together.ts";

export type Ready = { task: Task; title: string; verdict?: Verdict; done?: TaskEvent; blocks: string[] };
export type Away = { question: Question; decision?: Decision };
export type Unfinished = { id: string; title: string; reason: string };
export type SummaryInput = {
  title: string; ready: Ready[]; merged: string[]; unfinished: Unfinished[];
  calls: string[]; away: Away[]; asking: Question[]; cut: string[]; open: Decision[]; spent: number; limit?: number;
  together?: { result: Together; stale: string[] };
};

const RISK = { high: 0, medium: 1, low: 2 } as const;
const riskRank = (r: Ready) => RISK[r.verdict?.risk ?? "medium"];
const list = (ids: string[]) => (ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

// PRs other tasks wait on come first, because nothing behind them can start until they merge. Then riskier work, while there's time to fix it.
// A stacked PR can only merge after the one it builds on, so it never comes before it.
export function reviewOrder(ready: Ready[]): Ready[] {
  const ranked = [...ready].sort((a, b) => b.blocks.length - a.blocks.length || riskRank(a) - riskRank(b));
  const out: Ready[] = [];
  const place = (r: Ready) => {
    if (out.includes(r)) return;
    const parent = ranked.find((p) => p.task.id === r.task.stackedOn);
    if (parent) place(parent);
    out.push(r);
  };
  ranked.forEach(place);
  return out;
}

function why(r: Ready, parent?: Ready): string {
  if (r.task.stackedOn) return ` - builds on ${parent?.task.pr ? `#${parent.task.pr} (${r.task.stackedOn})` : r.task.stackedOn}, so merge it after that`;
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
      `${i + 1}. **${r.task.pr ? `#${r.task.pr} ` : ""}${r.title}** (${r.task.id})${why(r, ordered.find((p) => p.task.id === r.task.stackedOn))}`,
      ...(r.done?.test?.length ? ["   - Test:", ...r.done.test.map((t) => `     - ${t}`)] : ["   - Test: the worker gave no steps"]),
      ...(r.done?.assumptions ?? []).map((a) => `   - Check: ${a}`),
      `   - Risk: ${r.verdict?.risk ?? "not reviewed"}${r.verdict?.risk_note ? `. ${r.verdict.risk_note}` : ""}`,
    ]) : ["Nothing is ready yet."]),
    "",
    ...(s.together ? renderTogether(s.together.result, s.together.stale) : []),
    ...(s.merged.length ? ["## Already merged", "", list(s.merged), ""] : []),
    ...(s.unfinished.length ? ["## Not finished", "", ...s.unfinished.map((u) => `- **${u.title}** (${u.id}): ${u.reason}`), ""] : []),
    ...(s.calls.length ? ["## Calls Foreman made for you", "", ...s.calls.map((c) => `- ${c}`), ""] : []),
    ...(s.away.length ? ["## Calls Foreman made while you were away", "", ...s.away.map(awayCall), ""] : []),
    ...(s.open.length || s.asking.length || s.cut.length
      ? [
        "## Still open", "",
        ...s.asking.map((q) => `- ${q.id}${q.task ? ` (${q.task})` : ""}: ${q.question} Waiting for your answer.`),
        ...s.open.map((d) => `- ${d.id}: ${d.title}. Proposed by ${d.by} and not decided yet.`),
        ...s.cut.map((c) => `- Cut: ${c}`), "",
      ]
      : []),
  ].join("\n");
}

function awayCall({ question: q, decision: d }: Away): string {
  const undo = !d ? "" : d.status === "accepted" ? ` This accepted ${d.id}. To undo it, tell Foreman to overrule ${d.id}.` : ` This rejected ${d.id}. To undo it, tell Foreman to propose it again.`;
  const late = q.userAnswer ? ` You answered later: "${q.userAnswer}".` : "";
  return `- ${q.task ? `${q.task}: ` : ""}${q.question} Foreman went with: ${q.call.replace(/\.$/, "")}.${undo}${late}`;
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
  const result = loadTogether(repo);
  const prs = tasks.filter(hasOpenPr)
    .map((t) => ({ id: t.id, pr: t.pr!, branch: t.branch, sha: run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", t.branch]).stdout.trim() }));
  const decisions = loadDecisions(repo);
  const questions = loadQuestions(repo);
  const spent = tasks.reduce((sum, t) => sum + taskCost(repo, t).total, 0) + orchestratorCost(repo).usd;
  return {
    title: plan?.title ?? "Foreman tasks", ready, merged, unfinished, calls: plan?.calls ?? [], cut: plan?.cut ?? [],
    // A question about a decision already shows as that open decision.
    asking: questions.filter((q) => !q.answeredAt && !q.decision),
    // An overruled decision is the user's answer now, so it's no longer a call to check.
    away: questions.filter((q) => q.by === "foreman").map((q) => ({ question: q, decision: decisions.find((d) => d.id === q.decision) }))
      .filter((a) => !(a.decision?.status === "rejected" && a.decision.decidedBy)),
    open: decisions.filter((d) => d.status === "proposed"), spent, limit: budgetOf(repo).plan,
    ...(result && prs.length ? { together: { result, stale: staleness(result, prs) } } : {}),
  };
}

const ESC = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const BOLD = ESC("1");
const HEADING = ESC("1;33");
const CODE = ESC("36");

// The summary is written for GitHub-style Markdown, so the terminal copy turns its marks into colour instead of showing asterisks and hashes.
export function forTerminal(md: string): string {
  return md.split("\n").map((line) => {
    const heading = line.match(/^#{1,3} (.+)$/);
    if (heading) return HEADING(heading[1]!);
    return line.replace(/\*\*(.+?)\*\*/g, (_m, s) => BOLD(s)).replace(/`([^`]+)`/g, (_m, s) => CODE(s));
  }).join("\n");
}

// -F prints a short summary without opening the pager, -X leaves it on screen after q so its PR numbers can be copied, and -R lets the colour through.
export async function page(text: string): Promise<void> {
  // Ctrl-C reaches the pager too, and if Foreman exits first, less keeps the terminal with nothing behind it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const proc = Bun.spawn(["sh", "-c", process.env.PAGER || "less"], {
      stdin: "pipe", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, LESS: `${process.env.LESS ?? ""} -FRX`.trim() },
    });
    proc.stdin.write(text + "\n");
    await proc.stdin.end();
    if ((await proc.exited) !== 0) console.log(text);
  } finally {
    process.off("SIGINT", ignore);
  }
}

// A task keeps its PR open while its worker is blocked, over budget or fixing review feedback.
const hasOpenPr = (t: Task) => !!t.pr && !t.mergedAt && t.status !== "torn-down";

export function openPrs(repo: Repo): Task[] {
  return reviewOrder(gather(repo, loadPlan(repo)).ready).map((r) => r.task).filter(hasOpenPr);
}

export function writeSummary(repo: Repo): string {
  const path = join(repo.foreman, "summary.md");
  writeFileSync(path, renderSummary(gather(repo, loadPlan(repo))));
  return path;
}

export const summaryText = (repo: Repo) => `wrote ${writeSummary(repo)}`;
