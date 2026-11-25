import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, type TaskEvent } from "./events.ts";
import { loadDecisions, type Decision } from "./ledger.ts";
import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { notifyOrchestrator, sendToTask } from "./send.ts";
import { baseRef } from "./snapshot.ts";
import { budgetOf, lastActivity, overBudget, planSpend, taskCost } from "./cost.ts";
import { loadConfig } from "./config.ts";
import { loadPlan, readyTasks, maxWorkers, stackable } from "./plan.ts";
import { restartWorker, stopWorker } from "./stop.ts";
import { inFlight, loadTasks, updateTask, type Task } from "./state.ts";

export type PrState = { state: string; comments: number; base?: string };
export type TrackedPr = { key: string; number: number; base?: string };
export type Stall = { since: number; nudged: boolean; escalated: boolean };
export type Cursor = { events: Record<string, number>; main?: string; exited: string[]; prs?: Record<string, PrState>; budget?: Record<string, number>; stalls?: Record<string, Stall>; restarts?: Record<string, number> };

export type Probes = {
  events(id: string): TaskEvent[];
  mainSha(): string | undefined;
  alive(task: Task): boolean;
  pr?(number: number): PrState | undefined;
  lastActivity?(task: Task): number | undefined;
};

export type StallCheck = { now: number; stallMs: number; waiting?: (id: string) => string[] };

export const STALL_MINUTES = 20;
export const MAX_RESTARTS = 2;

export function scan(tasks: Task[], cursor: Cursor, probes: Probes, prs: TrackedPr[] = [], stall?: StallCheck): { reasons: string[]; cursor: Cursor; nudge: string[]; restart: string[] } {
  const next: Cursor = { ...cursor, events: { ...cursor.events }, exited: [...cursor.exited], prs: { ...cursor.prs }, stalls: { ...cursor.stalls }, restarts: { ...cursor.restarts } };
  const reasons: string[] = [];
  const nudge: string[] = [];
  const restart: string[] = [];

  for (const task of tasks) {
    const events = probes.events(task.id);
    for (const e of events.slice(next.events[task.id] ?? 0)) {
      reasons.push(e.note ? `${e.type} ${task.id}: ${clip(e.note)}` : `${e.type} ${task.id}`);
    }
    next.events[task.id] = events.length;

    if (!task.tab || task.status === "exited" || task.status === "over-budget") continue;
    const alive = probes.alive(task);
    // A resumed worker can exit again, and that exit must be reported too.
    if (alive) next.exited = next.exited.filter((id) => id !== task.id);
    else if (!next.exited.includes(task.id)) {
      reasons.push(`exited ${task.id}`);
      next.exited.push(task.id);
    }
    if (alive && stall) checkStall(task, probes, stall, next, reasons, nudge, restart);
  }
  for (const id of [...Object.keys(next.stalls!), ...Object.keys(next.restarts!)]) {
    if (!tasks.some((t) => t.id === id && t.status === "running")) delete next.stalls![id], delete next.restarts![id];
  }

  for (const { key, number, base } of prs) {
    const now = probes.pr?.(number);
    if (!now) continue;
    const seen = next.prs![`${number}`];
    if (seen && now.comments > seen.comments) reasons.push(`pr-comments ${key} #${number} (+${now.comments - seen.comments})`);
    if (now.state === "MERGED" && seen?.state !== "MERGED") reasons.push(base && now.base && now.base !== base ? `merged-early ${key} #${number} into ${now.base}` : `merged ${key} #${number}`);
    if (now.state === "CLOSED" && seen?.state !== "CLOSED") reasons.push(`closed ${key} #${number}${stackedOnto(tasks, key)}`);
    next.prs![`${number}`] = now;
  }

  const sha = probes.mainSha();
  if (sha && next.main && sha !== next.main) reasons.push(`main-moved ${sha.slice(0, 8)}`);
  if (sha) next.main = sha;

  return { reasons, cursor: next, nudge, restart };
}

// A worker idling on a hung background command never wakes by itself, so it's nudged, then restarted, and only a worker that keeps hanging reaches the orchestrator.
function checkStall(task: Task, probes: Probes, check: StallCheck, cursor: Cursor, reasons: string[], nudge: string[], restart: string[]): void {
  const stalls = cursor.stalls!;
  const last = task.status === "running" ? probes.lastActivity?.(task) : undefined;
  if (last === undefined) return void delete stalls[task.id];
  let s = stalls[task.id];
  if (!s || s.since !== last) s = stalls[task.id] = { since: last, nudged: false, escalated: false };
  const idle = check.now - last;
  if (idle >= 2 * check.stallMs && !s.escalated) {
    s.escalated = true;
    const restarts = cursor.restarts![task.id] ?? 0;
    if (restarts < MAX_RESTARTS) {
      cursor.restarts![task.id] = restarts + 1;
      restart.push(task.id);
      return;
    }
    const waiting = check.waiting?.(task.id) ?? [];
    const blocks = waiting.length ? `, and ${waiting.join(", ")} ${waiting.length > 1 ? "wait" : "waits"} on it` : "";
    reasons.push(`stuck ${task.id}: hung again after ${restarts} restarts${blocks}`);
  } else if (idle >= check.stallMs && !s.nudged) {
    s.nudged = true;
    nudge.push(task.id);
  }
}

export const NUDGE = "You've done nothing for a while. If you're waiting on a command, check it's still making progress: a test run that hasn't printed anything for minutes has usually hung. Kill it, then rerun it with a time limit, or report blocked with what you found. Never end your turn waiting on a command that has no time limit.";

// The PR's branch is the start of each task stacked on it, so closing it leaves them with work that may never merge.
function stackedOnto(tasks: Task[], id: string): string {
  const ids = tasks.filter((t) => t.stackedOn === id).map((t) => t.id);
  return ids.length ? `, which ${ids.join(" and ")} ${ids.length > 1 ? "build" : "builds"} on` : "";
}

const clip = (s: string) => (s.length > 100 ? s.slice(0, 97) + "..." : s);

const POLL_MS = 30_000;
// gh calls cost rate limit, and PR changes are rarely urgent.
const GH_POLL_MS = 5 * 60_000;

export function trackedPrs(tasks: Task[], decisions: Decision[]): TrackedPr[] {
  const prs: TrackedPr[] = tasks.filter((t) => t.pr).map((t) => ({ key: t.id, number: t.pr!, base: t.base }));
  for (const n of new Set(decisions.flatMap((d) => (d.adr?.pr ? [d.adr.pr] : [])))) prs.push({ key: "decisions", number: n });
  return prs;
}

function ghPr(root: string, number: number): PrState | undefined {
  const r = run(["gh", "pr", "view", String(number), "--json", "state,comments,reviews,baseRefName"], { cwd: root });
  if (r.code !== 0) return undefined;
  const pr = JSON.parse(r.stdout);
  return { state: pr.state, comments: pr.comments.length + pr.reviews.filter((x: { body: string }) => x.body).length, base: pr.baseRefName };
}

// A closed or early-merged PR stays "pr-open" in the task's status, and foreman next must not start new work on its branch.
export function prPatches(tasks: Task[], prs: TrackedPr[], seen: Record<string, PrState>): [string, Partial<Task>][] {
  return prs.flatMap(({ key, number, base }): [string, Partial<Task>][] => {
    const task = tasks.find((t) => t.id === key);
    const s = seen[`${number}`];
    if (!task || !s) return [];
    if (s.state === "CLOSED" && !task.prClosed) return [[key, { prClosed: true }]];
    if (s.state === "MERGED" && s.base && s.base !== base && !task.mergedInto) return [[key, { mergedInto: s.base }]];
    return [];
  });
}

export async function watch(repo: Repo, base: string, term: Terminal): Promise<number> {
  const pidFile = join(repo.foreman, "watch.pid");
  const other = readPid(pidFile);
  if (other && pidAlive(other)) {
    console.log(`watcher: already armed (pid ${other})`);
    return 0;
  }
  mkdirSync(join(repo.foreman, "tasks"), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  const release = () => rmSync(pidFile, { force: true });
  process.on("SIGTERM", () => (release(), process.exit(143)));
  process.on("SIGINT", () => (release(), process.exit(130)));

  const cursorFile = join(repo.foreman, "watch.cursor");
  let cursor: Cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : { events: {}, exited: [] };
  const probes: Probes = {
    events: (id) => readEvents(repo, id),
    mainSha: () => run(["git", "-C", repo.root, "rev-parse", baseRef(repo, base)]).stdout.trim() || undefined,
    alive: (task) => (task.tab ? term.alive(task.tab) : true),
    lastActivity: (task) => lastActivity(repo, task),
  };
  const stallMs = (loadConfig(repo).stallMinutes ?? STALL_MINUTES) * 60_000;
  const waiting = (id: string) => {
    const plan = loadPlan(repo);
    if (!plan?.approvedAt) return [];
    return readyTasks(plan, loadTasks(repo), maxWorkers(repo), stackable(repo)).waiting.filter((w) => new RegExp(`\\b${id}\\b`).test(w.reason)).map((w) => w.id);
  };
  let lastGh = 0;
  const watched = [join(repo.foreman, "tasks"), join(repo.root, ".git", "refs"), join(repo.root, ".git", "packed-refs")].filter(existsSync);
  const hasOrigin = run(["git", "-C", repo.root, "remote", "get-url", "origin"]).code === 0;

  try {
    for (;;) {
      const tasks = inFlight(loadTasks(repo));
      const ghDue = Date.now() - lastGh >= GH_POLL_MS;
      if (ghDue) lastGh = Date.now();
      // Merges happen on GitHub, so origin's base only moves here when it's fetched.
      if (ghDue && hasOrigin) run(["git", "-C", repo.root, "fetch", "-q", "origin", base]);
      const prs = trackedPrs(tasks, loadDecisions(repo)).filter((p) => !["MERGED", "CLOSED"].includes(cursor.prs?.[`${p.number}`]?.state ?? ""));
      const result = scan(tasks, cursor, { ...probes, pr: ghDue ? (n) => ghPr(repo.root, n) : undefined }, prs, { now: Date.now(), stallMs, waiting });
      cursor = result.cursor;
      for (const [id, patch] of prPatches(tasks, prs, cursor.prs ?? {})) updateTask(repo, id, patch);
      for (const id of result.nudge) {
        try {
          sendToTask(repo, tasks.find((t) => t.id === id)!, NUDGE, term);
        } catch {}
      }
      for (const id of result.restart) {
        const task = tasks.find((t) => t.id === id)!;
        try {
          restartWorker(repo, task, term, task.tab!.session);
        } catch (err) {
          result.reasons.push(`stuck ${id}: restarting its hung worker failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      {
        const over = overBudget(tasks.map((t) => taskCost(repo, t)), planSpend(repo, loadTasks(repo)), budgetOf(repo), cursor.budget ?? {});
        result.reasons.push(...over.reasons);
        cursor.budget = over.alerted;
        for (const id of over.stop) {
          const task = tasks.find((t) => t.id === id)!;
          if (stopWorker(repo, task, term)) result.reasons.push(`stopped ${id}`);
        }
      }
      writeFileSync(cursorFile, JSON.stringify(cursor));
      if (result.reasons.length) {
        const line = result.reasons.join("; ");
        console.log(line);
        notifyOrchestrator(repo, `[foreman watcher] ${line}. Handle it, then re-arm with \`foreman watch\` in the background.`);
        return 0;
      }
      await waitForChange(watched, POLL_MS);
    }
  } finally {
    release();
  }
}

async function waitForChange(paths: string[], ms: number): Promise<void> {
  const proc = Bun.spawn(["fswatch", "-1", "-r", "-l", "0.5", ...paths], { stdout: "ignore", stderr: "ignore" });
  let timer: Timer | undefined;
  await Promise.race([proc.exited, new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
  proc.kill();
}

export function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function watcherArmed(repo: Repo): boolean {
  const pid = readPid(join(repo.foreman, "watch.pid"));
  return pid !== undefined && pidAlive(pid);
}
