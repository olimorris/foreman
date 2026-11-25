import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { budgetOf, orchestratorCost, planSpend, taskCost, usd } from "./cost.ts";
import { activeLimit, resetPhrase, type UsageLimit } from "./limits.ts";
import { transcripts, type Activity } from "./transcripts.ts";
import { readEvents } from "./events.ts";
import { loadDecisions } from "./ledger.ts";
import { statusLabel } from "./overview.ts";
import { plainTitle } from "./brief.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, maxWorkers, readyTasks, type Waiting } from "./plan.ts";
import { latest, type Verdict } from "./rounds.ts";
import { loadTasks, type Task } from "./state.ts";
import { isFinished, isMerged, needsUser } from "./lifecycle.ts";
import type { Tab, Terminal } from "./terminal.ts";
import { pluginRoot } from "./paths.ts";
import { writeJson } from "./store.ts";
import { STALL_MINUTES, watcherArmed } from "./watch.ts";
import { blockParts, openBlocks, type PermissionBlock } from "./permissions.ts";
import { permissionLabel } from "./status.ts";
import { clip } from "./text.ts";

export type PaneTask = { task: Task; title: string; spent: number; risk?: Verdict["risk"]; note?: string; activity?: Activity; closed?: boolean };
export type OpenDecision = { id: string; title: string; by: string };
export type Recent = { at: number; text: string };
export type PaneInput = {
  name: string; plan?: string; deadline?: string; approved: boolean; armed: boolean; now: number; stallMs: number;
  spent: number; limit?: number; maxWorkers: number; tasks: PaneTask[]; waiting: (Waiting & { title: string })[]; recent: Recent[];
  decisions: OpenDecision[]; usageLimit?: UsageLimit; blocks?: PermissionBlock[];
};

type Tone = "bold" | "dim" | "red" | "yellow" | "green" | "cyan" | "heading";
const CODES: Record<Tone, string> = { bold: "1", dim: "2", red: "31", yellow: "33", green: "32", cyan: "36", heading: "1;33" };
type Paint = (tone: Tone, s: string) => string;
export const paint = (colour: boolean): Paint => (tone, s) => (colour && s ? `\x1b[${CODES[tone]}m${s}\x1b[0m` : s);

export function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);


// Columns are fitted to the pane's width: a line is cut before it's coloured, so colour codes never count towards the width.
export function renderPane(p: PaneInput, width: number, colour = false): string[] {
  const c = paint(colour);
  const fit = (s: string, room = width) => clip(s, Math.max(4, room));
  const out: string[] = [];
  const twoSides = (left: string, right: string, tone: Tone = "dim", leftTone?: Tone) => {
    const l = fit(left, width - right.length - 2);
    return `${leftTone ? c(leftTone, l) : l}${" ".repeat(Math.max(2, width - l.length - right.length))}${c(tone, right)}`;
  };

  out.push(twoSides(`FOREMAN  ${p.name}`, clock(p.now), "dim", "heading"));
  if (p.plan) out.push(c("bold", fit(p.plan + (p.approved ? "" : "  (not approved yet)"))));
  if (p.deadline) out.push(c("dim", fit(`Due ${p.deadline}`)));
  const spend = p.limit !== undefined ? `${usd(p.spent)} of ${usd(p.limit)} spent` : `${usd(p.spent)} spent`;
  const active = p.tasks.filter((t) => !isFinished(t.task));
  const watcher = p.armed ? "watcher on" : "watcher off";
  const facts = fit(`${spend} · ${active.length} of ${p.maxWorkers} slots · ${watcher}`);
  out.push(facts.endsWith(watcher) ? c("dim", facts.slice(0, -watcher.length)) + c(p.armed ? "green" : "red", watcher) : c("dim", facts));
  if (p.usageLimit) out.push(c("yellow", fit(`Usage limit reached · work resumes at ${resetPhrase(p.usageLimit, p.now)}`)));
  const blocksOf = (t: PaneTask) => (t.task.status === "pr-open" ? [] : (p.blocks ?? []).filter((b) => b.task === t.task.id));
  // An open PR has its own section below, so it isn't listed twice.
  const needsYou = (t: PaneTask) => (needsUser(t.task) && t.task.status !== "pr-open") || !!t.closed || blocksOf(t).length > 0;
  const own = (p.blocks ?? []).filter((b) => b.role === "orchestrator");
  const section = (title: string, rows: string[]) => rows.length && out.push("", c("heading", title.toUpperCase()), ...rows);

  // Runs started before workers were numbered have none to show, so the column only appears when it says something.
  const workers = p.tasks.some((t) => t.task.worker);
  const head = (t: PaneTask, right: string, rightTone: Tone = "dim") => {
    const label = `${t.task.id.padEnd(4)}${workers ? (t.task.worker ?? "").padEnd(4) : ""}${t.title}`;
    const l = fit(label, width - right.length - 3);
    return ` ${c("bold", l.slice(0, 4))}${l.slice(4)}${" ".repeat(Math.max(2, width - 1 - l.length - right.length))}${c(rightTone, right)}`;
  };
  const indent = workers ? 9 : 5;
  const detail = (text: string, tone: Tone = "dim", right = "", rightTone: Tone = "dim") => {
    const t = fit(text, width - indent - (right ? right.length + 2 : 0));
    return `${" ".repeat(indent)}${c(tone, t)}${right ? " ".repeat(Math.max(2, width - indent - t.length - right.length)) + c(rightTone, right) : ""}`;
  };

  section("Needs you", [
    ...(own.length ? [twoSides(" The orchestrator", permissionLabel(own), "red"), ...own.flatMap((b) => blockParts(b).map((l) => detail(l, "red")))] : []),
    ...active.filter(needsYou).flatMap((t) => {
      const held = blocksOf(t);
      const label = t.closed ? "worker closed" : held.length && t.task.status === "running" ? permissionLabel(held) : statusLabel(t.task);
      return [
        head(t, label, "red"),
        ...(t.note && !t.closed ? [detail(t.note, "red")] : []),
        ...held.flatMap((b) => blockParts(b).map((l) => detail(l, "red"))),
      ];
    }),
    ...p.decisions.map((d) => {
      const right = `decision from ${d.by}`;
      const l = fit(`${d.id.padEnd(5)}${d.title}`, width - right.length - 3);
      return ` ${c("bold", l.slice(0, 5))}${l.slice(5)}${" ".repeat(Math.max(2, width - 1 - l.length - right.length))}${c("red", right)}`;
    }),
  ]);

  const quiet = (a: Activity) => {
    const idle = p.now - a.since;
    const tone: Tone = idle >= p.stallMs ? "red" : idle >= p.stallMs / 2 ? "yellow" : "dim";
    return { text: duration(idle), tone };
  };
  section("Working", active.filter((t) => !needsYou(t) && ["running", "done", "limited"].includes(t.task.status)).flatMap((t) => {
    if (t.task.status === "limited") return [head(t, usd(t.spent)), detail("paused until the usage limit resets", "yellow")];
    if (t.task.status === "done") return [head(t, usd(t.spent)), detail(p.usageLimit ? "review waits for the usage limit" : `in review, round ${(t.task.reviews ?? 0) || 1}`, p.usageLimit ? "yellow" : "cyan")];
    const a = t.activity;
    if (!a) return [head(t, usd(t.spent)), detail("starting")];
    const q = quiet(a);
    return [head(t, usd(t.spent)), detail(a.idle ? "idle" : a.what, a.idle ? q.tone : "cyan", q.text, q.tone)];
  }));

  section("Ready to merge", active.filter((t) => t.task.status === "pr-open").map((t) =>
    head(t, `#${t.task.pr ?? "?"}${t.risk ? ` risk ${t.risk}` : ""}`, t.risk === "high" ? "red" : t.risk === "medium" ? "yellow" : "green")));

  section("Waiting", p.waiting.map((w) => ` ${c("bold", w.id.padEnd(4))}${c("dim", fit(w.reason, width - 5))}`));

  const done = p.tasks.filter((t) => isMerged(t.task));
  if (done.length) out.push("", c("dim", fit(`Merged: ${done.map((t) => t.task.id + (t.task.pr ? ` #${t.task.pr}` : "")).join(", ")}`)));

  if (p.recent.length) section("Recent", p.recent.map((r) => ` ${c("dim", clock(r.at))}  ${fit(r.text, width - 8)}`));
  if (!p.tasks.length && !p.waiting.length) out.push("", c("dim", "No tasks yet. Give the orchestrator a backlog."));
  return out;
}

const RECENT = 6;

const EVENT_WORDS: Record<string, string> = { done: "finished", blocked: "blocked", "needs-decision": "needs a decision", rebased: "rebased", exited: "worker closed", reviewed: "reviewed" };

// costs holds each task's spend, the orchestrator's under "foreman" and what foreman budget counts for the plan under "plan", as spendByTask returns them.
export function gatherPane(repo: Repo, now = Date.now(), costs: Map<string, number> = new Map(), closed: Set<string> = new Set()): PaneInput {
  const tasks = loadTasks(repo);
  const plan = loadPlan(repo);
  const max = maxWorkers(repo);
  const recent: Recent[] = [];
  const paneTasks = tasks.map((task): PaneTask => {
    const events = readEvents(repo, task.id);
    for (const e of events) recent.push({ at: Date.parse(e.at), text: `${task.id} ${EVENT_WORDS[e.type] ?? e.type}${e.note ? `: ${e.note}` : ""}` });
    recent.push({ at: Date.parse(task.createdAt), text: `${task.id} started${task.worker ? ` on ${task.worker}` : ""}` });
    if (task.mergedAt) recent.push({ at: Date.parse(task.mergedAt), text: `${task.id} merged${task.pr ? ` #${task.pr}` : ""}` });
    const lastNote = [...events].reverse().find((e) => e.type === task.status)?.note;
    return {
      task,
      title: plainTitle(task.title ?? plan?.tasks.find((t) => t.id === task.id)?.title ?? ""),
      spent: costs.get(task.id) ?? 0,
      risk: latest(repo, task)?.verdict?.risk,
      note: lastNote,
      activity: task.status === "running" ? transcripts(repo, task).activity() : undefined,
      closed: task.status === "running" && closed.has(task.id),
    };
  });
  const waiting = plan?.approvedAt ? readyTasks(plan, tasks, max).waiting.map((w) => ({ ...w, title: plan.tasks.find((t) => t.id === w.id)?.title ?? "" })) : [];
  const budget = budgetOf(repo);
  return {
    name: basename(repo.root),
    plan: plan?.title,
    deadline: plan?.deadline,
    approved: !!plan?.approvedAt,
    armed: watcherArmed(repo),
    now,
    stallMs: (loadConfig(repo).stallMinutes ?? STALL_MINUTES) * 60_000,
    spent: costs.get("plan") ?? 0,
    limit: budget.plan,
    maxWorkers: max,
    tasks: paneTasks,
    waiting,
    recent: recent.filter((r) => !Number.isNaN(r.at)).sort((a, b) => b.at - a.at).slice(0, RECENT),
    decisions: loadDecisions(repo).filter((d) => d.status === "proposed").map((d) => ({ id: d.id, title: d.title, by: d.by })),
    usageLimit: activeLimit(repo, now),
    blocks: openBlocks(repo),
  };
}

// Spend comes from reading whole transcripts, so it's refreshed less often than what the workers are doing.
export function spendByTask(repo: Repo): Map<string, number> {
  const tasks = loadTasks(repo);
  const costs = new Map(tasks.map((t) => [t.id, taskCost(repo, t).total]));
  costs.set("foreman", orchestratorCost(repo).usd);
  costs.set("plan", planSpend(repo, tasks));
  return costs;
}

const REDRAW_MS = 2_000;
const SPEND_MS = 30_000;

// Checking whether each worker's tab is still open asks the terminal, so it's refreshed with the spend rather than on every redraw.
function closedTabs(repo: Repo, term: Terminal): Set<string> {
  return new Set(loadTasks(repo).filter((t) => t.status === "running" && t.tab && !term.alive(t.tab)).map((t) => t.id));
}

export async function livePane(repo: Repo, term: Terminal): Promise<never> {
  const out = process.stdout;
  out.write("\x1b[?25l");
  const restore = () => (out.write("\x1b[?25h\n"), process.exit(0));
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  let costs = new Map<string, number>();
  let closed = new Set<string>();
  let checkedAt = 0;
  // A half-written config or a transcript removed mid-read must not kill the pane, or foreman pane would open a second one beside the dead one.
  const draw = () => {
    try {
      if (Date.now() - checkedAt >= SPEND_MS) (costs = spendByTask(repo)), (closed = closedTabs(repo, term)), (checkedAt = Date.now());
      const lines = renderPane(gatherPane(repo, Date.now(), costs, closed), Math.max(30, (out.columns ?? 60) - 1), !process.env.NO_COLOR);
      // Rewriting in place instead of clearing first stops the pane flickering on every redraw.
      out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
    } catch (err) {
      out.write(`\x1b[H\x1b[2Jforeman pane: ${err instanceof Error ? err.message : err}\x1b[J`);
    }
  };
  out.on("resize", draw);
  for (;;) {
    draw();
    await Bun.sleep(REDRAW_MS);
  }
}

export const paneFile = (repo: Repo) => join(repo.foreman, "pane.json");

export function savedPane(repo: Repo): Tab | undefined {
  try {
    return JSON.parse(readFileSync(paneFile(repo), "utf8"));
  } catch {
    return undefined;
  }
}


// A second pane would draw the same thing twice, so an open one is left alone.
export function openPane(repo: Repo, term: Terminal, session: string, anchor?: string): boolean {
  const open = savedPane(repo);
  if (open && open.session === session && term.alive(open)) return false;
  const cmd = [join(pluginRoot, "bin", "foreman"), "pane", "--live"];
  const tab = term.openBeside ? term.openBeside(session, anchor, "status", repo.root, cmd) : term.open(session, "status", repo.root, cmd);
  writeJson(paneFile(repo), tab);
  return true;
}
