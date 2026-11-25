import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { transcripts } from "./transcripts.ts";
import { shared } from "./decisions.ts";
import { readEvents, readRunLog, type RunEntry, type RunWhat, type TaskEvent } from "./events.ts";
import { styleFor, type Style } from "./style.ts";
import { statusLabel, taskTitle } from "./overview.ts";
import type { Repo } from "./paths.ts";
import { loadPlan } from "./plan.ts";
import { plainTitle } from "./brief.ts";
import { loadTasks } from "./state.ts";
import { STALL_MINUTES } from "./watch.ts";

export type History = {
  id: string; title: string; status: string; worker?: string;
  // What a planned task waits for is decided by the paths in its plan, which can be fewer than it owns once it has been granted more.
  owns: string[]; planOwns: string[]; deps: string[]; planned: boolean;
  createdAt?: number; mergedAt?: number; working: boolean;
  events: TaskEvent[]; replies: number[];
};
export type TimelineInput = { title: string; now: number; stallMs: number; approvedAt?: number; log: RunEntry[]; tasks: History[] };
export type Line = { at: number; task: string; text: string; tone?: "warn" | "alarm"; until?: number; also?: string };
export type Quiet = { from: number; to: number; open: boolean };

const MIN = 60_000;
// A worker's closing reply lands seconds after its foreman report, so a gap starting this close to a report is it waiting for the orchestrator, not hanging.
const REPORT_SLACK = 5 * MIN;
const ENDS_WORK: RunWhat[] = ["stopped", "paused", "merged", "torn-down"];
// foreman propose writes a needs-decision event led by the decision's id, but the worker carries on working.
const PROPOSAL = /^D-\d+ /;
const handsBack = (e: TaskEvent) => e.type === "done" || e.type === "blocked" || (e.type === "needs-decision" && !PROPOSAL.test(e.note ?? ""));

export function quietStretches(replies: number[], reports: number[], cuts: number[], minGap: number, now?: number): Quiet[] {
  const times = [...new Set(replies)].sort((a, b) => a - b);
  if (!times.length) return [];
  const ends = now === undefined ? times.slice(1) : [...times.slice(1), now];
  return ends.flatMap((end, i) => {
    const from = times[i]!;
    if (reports.some((r) => Math.abs(r - from) <= REPORT_SLACK)) return [];
    const cut = Math.min(...cuts.filter((c) => c > from && c < end));
    const to = Number.isFinite(cut) ? cut : end;
    return to - from >= minGap ? [{ from, to, open: to === now }] : [];
  });
}

export function duration(ms: number): string {
  const m = Math.round(ms / MIN);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

// Mirrors readyTasks, where a task with no owned paths clashes with every other task.
export function waitReason(y: History, x: History): string | undefined {
  if (x.id === y.id || !x.planned) return undefined;
  if (x.deps.includes(y.id)) return "which it depends on";
  if (!y.owns.length) return "which owns every path";
  if (!x.planOwns.length) return `since ${x.id} owns every path`;
  const paths = shared(y.owns, x.planOwns);
  if (!paths.length) return undefined;
  const file = paths.find((p) => !/[*?[{]/.test(p));
  const name = file ? basename(file) : paths[0]!;
  return `which shares ${name}${paths.length > 1 ? ` and ${paths.length - 1} other path${paths.length > 2 ? "s" : ""}` : ""}`;
}

const PHRASE: Record<RunWhat, (note?: string) => string> = {
  started: (n) => `started${n ? ` by ${n}` : ""}`,
  nudged: (n) => `nudged${n ? `: ${n}` : ""}`,
  restarted: (n) => `restarted${n ? `: ${n}` : ""}`,
  stopped: (n) => `stopped${n ? `: ${n}` : ""}`,
  paused: () => "paused",
  resumed: (n) => `resumed${n ? `: ${n}` : ""}`,
  "pr-opened": (n) => `opened PR ${n ?? ""}`.trim(),
  "pr-updated": (n) => `updated PR ${n ?? ""}`.trim(),
  merged: (n) => `merged${n ? ` PR ${n}` : ""}`,
  "torn-down": (n) => `torn down${n ? `, ${n}` : ""}`,
};
const WARNS: RunWhat[] = ["nudged", "restarted", "stopped"];

// The watcher logs "usage limit, resets 15:45" when it pauses a worker for the account's usage limit.
const LIMIT_NOTE = "usage limit";

function limitWait(task: string, paused: RunEntry, resumed?: RunEntry): Line {
  const at = Date.parse(paused.at);
  if (!resumed) return { at, task, tone: "warn", text: `paused for the ${paused.note}` };
  const to = Date.parse(resumed.at);
  return { at, task, tone: "warn", text: `waited ${duration(to - at)} for the usage limit to reset`, until: to };
}

const EVENT_LABEL: Record<TaskEvent["type"], string> = { done: "done", blocked: "blocked", "needs-decision": "needs a decision", rebased: "rebased", reviewed: "reviewed", exited: "worker closed" };

export function buildTimeline(input: TimelineInput): Line[] {
  const { now, stallMs, approvedAt, log } = input;
  const minGap = stallMs / 2;
  const entriesOf = (id: string) => log.filter((e) => e.task === id);
  const when = (id: string, what: RunWhat) => {
    const e = entriesOf(id).find((x) => x.what === what);
    return e ? Date.parse(e.at) : undefined;
  };
  // Tasks started before the run log existed still have their start and merge times in tasks.json.
  const startOf = (t: History) => when(t.id, "started") ?? t.createdAt;
  const releaseOf = (t: History) => t.mergedAt ?? when(t.id, "torn-down");

  const waits = (y: History, q: Quiet): Line[] => input.tasks.flatMap((x) => {
    const why = waitReason(y, x);
    if (!why || approvedAt === undefined) return [];
    const from = Math.max(q.from, approvedAt, startOf(y) ?? -Infinity);
    const to = Math.min(q.to, startOf(x) ?? now, releaseOf(y) ?? Infinity);
    const still = q.open && startOf(x) === undefined;
    return to - from >= minGap ? [{ at: from, task: y.id, also: x.id, tone: "warn" as const, text: `${x.id} ${still ? "has waited" : "waited"} ${duration(to - from)}${still ? " so far" : ""} for ${y.id}, ${why}` }] : [];
  });

  const lines: Line[] = [];
  for (const t of input.tasks) {
    const own = entriesOf(t.id);
    if (t.createdAt !== undefined && !own.some((e) => e.what === "started")) lines.push({ at: t.createdAt, task: t.id, text: "started" });
    if (t.mergedAt !== undefined && !own.some((e) => e.what === "merged")) lines.push({ at: t.mergedAt, task: t.id, text: "merged" });
    for (const [i, e] of own.entries()) {
      if (e.what === "paused" && e.note?.startsWith(LIMIT_NOTE)) {
        lines.push(limitWait(t.id, e, own.slice(i + 1).find((x) => x.what === "resumed")));
        continue;
      }
      lines.push({ at: Date.parse(e.at), task: t.id, text: PHRASE[e.what](e.note), ...(WARNS.includes(e.what) ? { tone: "warn" as const } : {}) });
    }
    for (const e of t.events) lines.push({ at: Date.parse(e.at), task: t.id, text: `${EVENT_LABEL[e.type]}${e.note ? `: ${e.note}` : ""}`, ...(e.type === "blocked" ? { tone: "warn" as const } : {}) });
    const reports = t.events.filter(handsBack).map((e) => Date.parse(e.at));
    const cuts = [...own.filter((e) => ENDS_WORK.includes(e.what)).map((e) => Date.parse(e.at)), ...(t.mergedAt !== undefined ? [t.mergedAt] : [])];
    for (const q of quietStretches(t.replies, reports, cuts, minGap, t.working ? now : undefined)) {
      lines.push({ at: q.from, task: t.id, text: `quiet for ${duration(q.to - q.from)}${q.open ? " so far" : ""}`, tone: q.to - q.from >= stallMs ? "alarm" : "warn", ...(q.open ? {} : { until: q.to }) });
      if (q.to - q.from >= stallMs) lines.push(...waits(t, q));
    }
  }
  return lines.sort((a, b) => a.at - b.at);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

function clockFor(times: number[]): (ms: number) => string {
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = new Set(times.map((t) => new Date(t).toDateString()));
  return days.size > 1 ? (ms) => `${DAYS[new Date(ms).getDay()]} ${hm(new Date(ms))}` : (ms) => hm(new Date(ms));
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 3)).trimEnd() + "..." : s);

// One group per task, in the order they started, because the morning question is what happened to each piece of work.
export function renderTimeline(input: TimelineInput, lines: Line[], opts: { style?: Style; only?: string; width?: number } = {}): string {
  const style = opts.style ?? styleFor();
  const width = opts.width ?? 120;
  const shown = opts.only ? lines.filter((l) => l.task === opts.only || l.also === opts.only) : lines;
  if (!shown.length) return opts.only ? `nothing has happened on ${opts.only} yet` : "Nothing has happened yet. Tasks show here once they start.";
  const clock = clockFor(shown.flatMap((l) => [l.at, ...(l.until !== undefined ? [l.until] : [])]));
  const groups = opts.only ? [opts.only] : [...new Set(lines.map((l) => l.task))];
  const tone = (l: Line) => (l.tone === "alarm" ? style.red : l.tone === "warn" ? style.yellow : (s: string) => s);

  const out = [style.dim(`${input.title}, ${clock(shown[0]!.at)} to ${clock(Math.max(...shown.map((l) => l.until ?? l.at)))}`)];
  for (const id of groups) {
    const t = input.tasks.find((x) => x.id === id);
    const heading = `${t?.worker ? `${t.worker} · ` : ""}${id}${t?.title ? `: ${t.title}` : ""}`;
    out.push("", `${style.heading(heading)}${t ? style.dim(`  ${t.status}`) : ""}`);
    for (const l of shown.filter((x) => x.task === id || x.also === id || opts.only)) {
      const time = clock(l.at);
      const text = `${l.text}${l.until !== undefined ? `, until ${clock(l.until)}` : ""}`;
      out.push(`${l.tone === "alarm" ? "!" : " "} ${style.dim(time)}  ${tone(l)(clip(text, width - time.length - 4))}`);
    }
  }
  out.push("", style.dim(`Quiet means the worker went ${duration(input.stallMs / 2)} or more without replying while it was meant to be working. ! marks ${duration(input.stallMs)} or more.`));
  return out.join("\n");
}

const ms = (iso?: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

// Transcripts are the slow part, so one task loads only itself and the tasks it could have waited on or held up.
export function gatherTimeline(repo: Repo, now = Date.now(), only?: string): TimelineInput {
  const plan = loadPlan(repo);
  const tasks = loadTasks(repo);
  const all: History[] = tasks.map((t) => {
    const p = plan?.tasks.find((x) => x.id === t.id);
    return {
      id: t.id, title: taskTitle(repo, t), status: `${statusLabel(t)}${t.pr ? `, PR #${t.pr}` : ""}`, worker: t.worker ?? undefined,
      owns: t.owns, planOwns: p?.owns ?? t.owns, deps: p?.deps ?? [], planned: !!p,
      createdAt: ms(t.createdAt), mergedAt: ms(t.mergedAt), working: t.status === "running", events: [], replies: [],
    };
  });
  for (const p of plan?.tasks ?? []) {
    if (tasks.some((t) => t.id === p.id)) continue;
    all.push({ id: p.id, title: plainTitle(p.title), status: "not started", owns: p.owns, planOwns: p.owns, deps: p.deps, planned: true, working: false, events: [], replies: [] });
  }
  const target = all.find((h) => h.id === only);
  if (only && !target) throw new Error(`no task ${only}`);
  const histories = target ? all.filter((h) => h === target || waitReason(target, h) || waitReason(h, target)) : all;
  for (const h of histories) {
    const task = tasks.find((t) => t.id === h.id);
    if (!task) continue;
    h.events = readEvents(repo, h.id);
    h.replies = transcripts(repo, task).replyTimes();
  }
  const stallMs = (loadConfig(repo).stallMinutes ?? STALL_MINUTES) * MIN;
  return { title: plan?.title ?? "Foreman tasks", now, stallMs, approvedAt: ms(plan?.approvedAt), log: readRunLog(repo), tasks: histories };
}

export function timelineText(repo: Repo, only?: string): string {
  const input = gatherTimeline(repo, Date.now(), only);
  return renderTimeline(input, buildTimeline(input), { only, width: process.stdout.isTTY ? process.stdout.columns : undefined });
}
