import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logRun, readEvents, type TaskEvent } from "./events.ts";
import { loadDecisions, type Decision } from "./ledger.ts";
import { answerMs, loadQuestions, type Question } from "./questions.ts";
import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { baseRef } from "./base.ts";
import { budgetOf, overBudget, planSpend, taskCost, taskLimit, usd, type Budget, type TaskCost } from "./cost.ts";
import { transcripts } from "./transcripts.ts";
import { loadConfig } from "./config.ts";
import { loadPlan, readyTasks, maxWorkers, stackable } from "./plan.ts";
import { pauseForLimit, restartWorker, resume, stopWorker } from "./stop.ts";
import { clockAt, loadLimit, resetPhrase, resumeDue, saveLimit, type LimitHit, type UsageLimit } from "./limits.ts";
import { taskDir } from "./paths.ts";
import { inFlight, loadTasks, updateTask, type Task } from "./state.ts";
import { tabOpen } from "./lifecycle.ts";
import { approved, automergeOn, checksOf, mergeCall, mergePr, repoMergeMethod, type Check, type Merge, type MergeMethod } from "./automerge.ts";
import { blockLine, syncBlocks, type PermissionBlock } from "./permissions.ts";
import { busy, commandName, isWorker, pidAlive, processesIn, sample, tidy, unstoppableLine, type CpuSample, type Proc } from "./procs.ts";
import { andList, clip } from "./text.ts";
import { needsOrchestrator, sync } from "./sync.ts";

export type PrState = { state: string; comments: number; base?: string; head?: string; sha?: string; draft?: boolean; checks?: Check[] };
export type TrackedPr = { key: string; number: number; base?: string };
export type Stall = { since: number; nudged: boolean; escalated: boolean; cpu?: CpuSample; measuredAt?: number; busyAt?: number };
export type Cursor = { events: Record<string, number>; main?: string; exited: string[]; prs?: Record<string, PrState>; budget?: Record<string, number>; stalls?: Record<string, Stall>; restarts?: Record<string, number>; unanswered?: string[]; unstoppable?: number[]; limit?: UsageLimit; limitEnded?: number; held?: string[]; unmergeable?: Record<string, string>; blocks?: string[] };
export type Nudge = { id: string; text: string };

export type Probes = {
  events(id: string): TaskEvent[];
  mainSha(): string | undefined;
  alive(task: Task): boolean;
  pr?(number: number): PrState | undefined;
  lastActivity?(task: Task): number | undefined;
  questions?(): Question[];
  processes?(task: Task): Proc[];
  limit?(task: Task): LimitHit | undefined;
  automerge?(): boolean;
  approved?(task: Task): boolean;
  blocks?(): PermissionBlock[];
  spend?(tasks: Task[]): Spend;
};

export type Spend = { costs: TaskCost[]; plan: number; budget: Budget };
export type Stop = { id: string; note: string };

export type ScanResult = { reasons: string[]; cursor: Cursor; nudge: Nudge[]; restart: string[]; pause: string[]; resume: string[]; merge: Merge[]; stop: Stop[]; sync: boolean; notice?: string };

export type Clock = { now: number; stallMs: number; answerMs?: number; waiting?: (id: string) => string[] };

export const STALL_MINUTES = 20;
export const MAX_RESTARTS = 2;
// A busy loop hangs too, so even a worker whose commands keep using CPU gets restarted once it has been silent this many stall periods.
export const BUSY_STALLS = 4;
// Passes come as often as files change, and CPU time measured over a second or two is mostly noise.
const MIN_SAMPLE_MS = 10_000;

export function scan(tasks: Task[], cursor: Cursor, probes: Probes, prs: TrackedPr[] = [], clock?: Clock): ScanResult {
  const next: Cursor = { ...cursor, events: { ...cursor.events }, exited: [...cursor.exited], prs: { ...cursor.prs }, stalls: { ...cursor.stalls }, restarts: { ...cursor.restarts }, unanswered: [...(cursor.unanswered ?? [])], unmergeable: { ...cursor.unmergeable }, ...(cursor.limit ? { limit: { ...cursor.limit, paused: [...cursor.limit.paused] } } : {}) };
  const reasons: string[] = [];
  const nudge: Nudge[] = [];
  const restart: string[] = [];
  const working: string[] = [];
  const merge: Merge[] = [];
  const blocks = probes.blocks?.() ?? [];
  // A worker waiting at a permission prompt is silent until the user answers, which isn't a hang.
  const prompted = new Set(blocks.filter((b) => b.kind === "prompt" && b.role === "worker").map((b) => b.task));

  // A worker at the usage limit replies to nothing until the reset, so it must not look hung.
  for (const task of next.limit ? [] : tasks.filter((t) => t.tab && t.status === "running")) {
    const hit = probes.limit?.(task);
    if (hit && hit.at > (next.limitEnded ?? 0)) {
      next.limit = { since: hit.at, resetsAt: hit.resetsAt, ...(hit.guessed ? { guessed: true } : {}), by: task.id, paused: [] };
      break;
    }
  }

  for (const task of tasks) {
    const events = probes.events(task.id);
    for (const e of events.slice(next.events[task.id] ?? 0)) {
      if (settledRebase(task, e)) continue;
      reasons.push(e.note ? `${e.type} ${task.id}: ${clip(e.note, 100)}` : `${e.type} ${task.id}`);
    }
    next.events[task.id] = events.length;

    if (!tabOpen(task)) continue;
    const alive = probes.alive(task);
    // A resumed worker can exit again, and that exit must be reported too.
    if (alive) next.exited = next.exited.filter((id) => id !== task.id);
    else if (!next.exited.includes(task.id)) {
      reasons.push(`exited ${task.id}`);
      next.exited.push(task.id);
    }
    if (alive && task.status === "running") working.push(task.id);
    if (prompted.has(task.id)) delete next.stalls![task.id];
    else if (alive && clock && !next.limit) checkStall(task, probes, clock, next, reasons, nudge, restart);
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
    const task = tasks.find((t) => t.id === key);
    // A head whose failing check or refused merge was already reported is skipped, or the orchestrator would hear about it every poll.
    if (!task || !probes.automerge?.() || !now.sha || next.unmergeable![`${number}`] === now.sha) continue;
    const call = mergeCall(task, now, probes.approved?.(task) ?? false);
    if (call === "merge") merge.push({ id: key, number, sha: now.sha });
    else if (call !== "wait") {
      reasons.push(`check-failed ${key} #${number}: ${call.failing.join(", ")}`);
      next.unmergeable![`${number}`] = now.sha;
    }
  }

  // The orchestrator already knows about its own blocks, so only the crew's wake it, once each.
  const told = new Set(cursor.blocks ?? []);
  for (const b of blocks) if (b.role !== "orchestrator" && !told.has(b.id)) reasons.push(`permission ${b.task}: ${blockLine(b)}`);
  next.blocks = blocks.map((b) => b.id);

  const open = (probes.questions?.() ?? []).filter((q) => !q.answeredAt);
  next.unanswered = next.unanswered!.filter((id) => open.some((q) => q.id === id));
  for (const q of open) {
    if (!clock?.answerMs || clock.now - Date.parse(q.askedAt) < clock.answerMs || next.unanswered.includes(q.id)) continue;
    reasons.push(`unanswered ${q.id}${q.decision ? ` (${q.decision})` : ""}: ${clip(q.question, 100)}`);
    next.unanswered.push(q.id);
  }

  const sha = probes.mainSha();
  const moved = !!sha && !!next.main && sha !== next.main;
  // A merge arrives as its own line, and the orchestrator only ever called sync for any other move, so the watcher syncs itself.
  // During the usage limit the workers can't take a rebase request, so the line is held for the orchestrator instead.
  const syncNow = moved && !next.limit && !reasons.some((r) => r.startsWith("merged "));
  if (moved && !syncNow) reasons.push(`main-moved ${sha!.slice(0, 8)}`);
  if (sha) next.main = sha;

  const stop = checkBudget(probes.spend?.(tasks), next, reasons);
  const { pause, resume, notice } = waitOutLimit(tasks, next, working, reasons, clock?.now);
  return { reasons, cursor: next, nudge, restart, pause, resume, merge, stop, sync: syncNow, notice };
}

// Words a worker uses when a rebase didn't go cleanly. A false match only costs the orchestrator a look.
const UNSETTLED = /conflict|fail|error|broke|block|abort|skip|undone|unfinished|left|todo|still|pending|manual|warn|not (yet|done|run|finished)|couldn.?t|can.?t|cannot|didn.?t|won.?t/i;

// A clean rebase of a task with no PR leaves the orchestrator nothing to do. One with a PR needs deliver, and a stacked one may be what deliver is waiting on.
export function settledRebase(task: Task, e: TaskEvent): boolean {
  return e.type === "rebased" && !task.pr && !task.stackedOn && !UNSETTLED.test(e.note ?? "");
}

function checkBudget(spend: Spend | undefined, cursor: Cursor, reasons: string[]): Stop[] {
  if (!spend) return [];
  const over = overBudget(spend.costs, spend.plan, spend.budget, cursor.budget ?? {});
  reasons.push(...over.reasons);
  cursor.budget = over.alerted;
  return over.stop.map((id) => {
    const spent = spend.costs.find((c) => c.id === id)!.total;
    const limit = taskLimit(spend.budget, id);
    return { id, note: limit !== undefined && spent > limit ? `over budget, ${usd(spent)} of ${usd(limit)}` : "the plan is over budget" };
  });
}

// What a pass does to the workers and PRs. The watcher's own adapter acts for real, and tests record the calls.
export type Effects = {
  pause(task: Task, note: string): void;
  resume(task: Task): void;
  nudge(task: Task, text: string): void;
  restart(task: Task): void;
  // Returns why the merge failed, or undefined once it merged.
  merge(pr: Merge): string | undefined;
  // Returns false when the worker's tab was already closed.
  stop(task: Task, note: string): boolean;
  // Returns what the sync found that needs the orchestrator, such as a task it marked merged.
  sync(): string[];
};

// Carries out what a pass found, adding what the orchestrator should hear about it to the pass's reasons. Returns how many PRs merged.
export function applyPass(result: ScanResult, tasks: Task[], effects: Effects, now: number): number {
  const task = (id: string) => tasks.find((t) => t.id === id)!;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let merged = 0;
  if (result.sync) {
    const moved = `main-moved ${result.cursor.main!.slice(0, 8)}`;
    try {
      const found = effects.sync();
      if (found.length) result.reasons.push(`${moved}, and the watcher's sync found: ${found.join("; ")}`);
    } catch (err) {
      result.reasons.push(`${moved}, and the watcher's sync failed, so call sync: ${clip(why(err), 100)}`);
    }
  }
  for (const id of result.pause) {
    try {
      effects.pause(task(id), `usage limit, resets ${clockAt(result.cursor.limit!.resetsAt, now)}`);
    } catch {}
  }
  for (const id of result.resume) {
    try {
      effects.resume(task(id));
    } catch (err) {
      result.reasons.push(`not-resumed ${id}: ${why(err)}`);
    }
  }
  for (const { id, text } of result.nudge) {
    try {
      effects.nudge(task(id), text);
    } catch {}
  }
  for (const id of result.restart) {
    try {
      effects.restart(task(id));
    } catch (err) {
      result.reasons.push(`stuck ${id}: restarting its hung worker failed: ${why(err)}`);
    }
  }
  for (const pr of result.merge) {
    const failed = effects.merge(pr);
    if (!failed) merged++;
    else {
      result.reasons.push(`not-merged ${pr.id} #${pr.number}: ${clip(failed, 100)}`);
      result.cursor.unmergeable = { ...result.cursor.unmergeable, [`${pr.number}`]: pr.sha };
    }
  }
  for (const { id, note } of result.stop) if (effects.stop(task(id), note)) result.reasons.push(`stopped ${id}`);
  return merged;
}

// Everything else the watcher finds during the wait is held for the resume line, since the orchestrator can't take a turn until the reset either.
function waitOutLimit(tasks: Task[], cursor: Cursor, working: string[], reasons: string[], now?: number): { pause: string[]; resume: string[]; notice?: string } {
  const limit = cursor.limit;
  if (!limit) return { pause: [], resume: [] };
  if (now !== undefined && resumeDue(limit, now)) {
    const resume = limit.paused.filter((id) => tasks.some((t) => t.id === id && t.status === "limited"));
    if (limit.announced) reasons.unshift(`usage-limit-reset: ${resume.length ? `resumed ${andList(resume)}` : "no workers were paused"}`);
    reasons.push(...(cursor.held ?? []));
    cursor.held = [];
    cursor.limit = undefined;
    cursor.limitEnded = now;
    return { pause: [], resume };
  }
  const pause = working.filter((id) => !limit.paused.includes(id));
  limit.paused.push(...pause);
  cursor.held = [...(cursor.held ?? []), ...reasons.splice(0)];
  if (limit.announced) return { pause, resume: [] };
  limit.announced = true;
  const paused = limit.paused.length ? `${andList(limit.paused)} ${limit.paused.length > 1 ? "are" : "is"} paused` : "No workers were running";
  return { pause, resume: [], notice: `usage-limit: ${limit.by} hit the usage limit, which resets at ${resetPhrase(limit, now ?? limit.since)}. ${paused} and reviews wait until then` };
}

// A worker idling on a hung background command never wakes by itself, so it's nudged, then restarted, and only a worker that keeps hanging reaches the orchestrator.
function checkStall(task: Task, probes: Probes, check: Clock, cursor: Cursor, reasons: string[], nudge: Nudge[], restart: string[]): void {
  const stalls = cursor.stalls!;
  const replied = task.status === "running" ? probes.lastActivity?.(task) : undefined;
  if (replied === undefined) return void delete stalls[task.id];
  // A resumed worker's last reply is from before the wait, so its silence counts from the resume.
  const last = Math.max(replied, cursor.limitEnded ?? 0);
  const prev = stalls[task.id];
  const s = prev?.since === last ? prev : (stalls[task.id] = { since: last, nudged: false, escalated: false, cpu: prev?.cpu, measuredAt: prev?.measuredAt, busyAt: prev?.busyAt });
  const all = probes.processes?.(task) ?? [];
  const procs = all.filter((p) => !isWorker(p, task));
  const before = s.cpu;
  if (!before || check.now - before.at >= MIN_SAMPLE_MS) {
    if (before && busy(before, all, check.now, task)) s.busyAt = check.now;
    if (before) s.measuredAt = check.now;
    s.cpu = sample(procs, check.now);
  }
  // A watcher armed after a long silence has nothing to compare yet, and would restart a busy build as if it had hung.
  if (procs.length && s.measuredAt === undefined) return;
  const silent = check.now - last;
  const idle = check.now - Math.max(last, s.busyAt ?? 0);
  const command = (busy: boolean) => commandName(all, task, before ?? s.cpu!, busy);
  if ((idle >= 2 * check.stallMs || silent >= BUSY_STALLS * check.stallMs) && !s.escalated) {
    s.escalated = true;
    const restarts = cursor.restarts![task.id] ?? 0;
    if (restarts < MAX_RESTARTS) {
      cursor.restarts![task.id] = restarts + 1;
      restart.push(task.id);
      return;
    }
    const waiting = check.waiting?.(task.id) ?? [];
    const blocks = waiting.length ? `, and ${waiting.join(", ")} ${waiting.length > 1 ? "wait" : "waits"} on it` : "";
    const named = command(idle < 2 * check.stallMs);
    const on = idle < 2 * check.stallMs ? `, though ${named ? `"${named}" is` : "its commands are"} still using CPU` : named ? `, waiting on "${named}", which uses no CPU` : "";
    reasons.push(`stuck ${task.id}: hung again after ${restarts} restarts${on}${blocks}`);
  } else if (idle >= check.stallMs && !s.nudged) {
    s.nudged = true;
    nudge.push({ id: task.id, text: nudgeText(command(false), Math.round(idle / 60_000)) });
  }
}

export function nudgeText(command?: string, minutes?: number): string {
  const seen = command ? `"${command}" in your worktree has used no CPU for ${minutes} minutes, so it has most likely hung.` : "If you're waiting on a command, check it's still making progress: a test run that hasn't printed anything for minutes has usually hung.";
  return `You've done nothing for a while. ${seen} Kill it, then rerun it with a time limit, or report blocked with what you found. Never end your turn waiting on a command that has no time limit.`;
}

// The PR's branch is the start of each task stacked on it, so closing it leaves them with work that may never merge.
function stackedOnto(tasks: Task[], id: string): string {
  const ids = tasks.filter((t) => t.stackedOn === id).map((t) => t.id);
  return ids.length ? `, which ${ids.join(" and ")} ${ids.length > 1 ? "build" : "builds"} on` : "";
}

const POLL_MS = 30_000;
// gh calls cost rate limit, and PR changes are rarely urgent.
const GH_POLL_MS = 5 * 60_000;

export function trackedPrs(tasks: Task[], decisions: Decision[]): TrackedPr[] {
  const prs: TrackedPr[] = tasks.filter((t) => t.pr).map((t) => ({ key: t.id, number: t.pr!, base: t.base }));
  for (const n of new Set(decisions.flatMap((d) => (d.adr?.pr ? [d.adr.pr] : [])))) prs.push({ key: "decisions", number: n });
  return prs;
}

function ghPr(root: string, number: number): PrState | undefined {
  const r = run(["gh", "pr", "view", String(number), "--json", "state,comments,reviews,baseRefName,headRefName,headRefOid,isDraft,statusCheckRollup"], { cwd: root });
  if (r.code !== 0) return undefined;
  const pr = JSON.parse(r.stdout);
  return {
    state: pr.state, comments: pr.comments.length + pr.reviews.filter((x: { body: string }) => x.body).length, base: pr.baseRefName,
    head: pr.headRefName, sha: pr.headRefOid, draft: pr.isDraft, checks: checksOf(pr.statusCheckRollup ?? []),
  };
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

export type WaitForChange = (paths: string[], ms: number, signal?: AbortSignal) => Promise<void>;
export type Watching = { signal?: AbortSignal; notice?: (notice: string) => void; wait?: WaitForChange };

// Runs the watcher's passes until one finds something for the orchestrator, and returns that line.
export async function watchFor(repo: Repo, base: string, term: Terminal, { signal, notice, wait = waitForChange }: Watching = {}): Promise<string> {
  const pidFile = join(repo.foreman, "watch.pid");
  const other = readPid(pidFile);
  if (other && pidAlive(other)) return `watcher: already running (pid ${other})`;
  mkdirSync(join(repo.foreman, "tasks"), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  const cursorFile = join(repo.foreman, "watch.cursor");
  let cursor: Cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : { events: {}, exited: [] };
  const probes: Probes = {
    events: (id) => readEvents(repo, id),
    mainSha: () => run(["git", "-C", repo.root, "rev-parse", baseRef(repo, base)]).stdout.trim() || undefined,
    alive: (task) => (task.tab ? term.alive(task.tab) : true),
    lastActivity: (task) => transcripts(repo, task).lastReply(),
    questions: () => loadQuestions(repo),
    limit: (task) => transcripts(repo, task).limit(),
    automerge: () => automergeOn(repo),
    approved: (task) => approved(repo, task),
    spend: (tasks) => ({ costs: tasks.map((t) => taskCost(repo, t)), plan: planSpend(repo, loadTasks(repo)), budget: budgetOf(repo) }),
  };
  const stallMs = (loadConfig(repo).stallMinutes ?? STALL_MINUTES) * 60_000;
  const waiting = (id: string) => {
    const plan = loadPlan(repo);
    if (!plan?.approvedAt) return [];
    return readyTasks(plan, loadTasks(repo), maxWorkers(repo), stackable(repo)).waiting.filter((w) => new RegExp(`\\b${id}\\b`).test(w.reason)).map((w) => w.id);
  };
  let lastGh = 0;
  let method: MergeMethod | undefined;
  const effects: Effects = {
    pause: (task, note) => pauseForLimit(repo, task, term, note),
    resume: (task) => void resume(repo, task.id, term, task.tab!.session, { prompt: resumePrompt(repo, task.id), note: "the usage limit reset" }),
    nudge: (task, text) => {
      sendToTask(repo, task, text, term);
      logRun(repo, task.id, "nudged", `no reply for ${stallMs / 60_000}m`);
    },
    restart: (task) => void restartWorker(repo, task, term, task.tab!.session, { note: `no reply for ${(2 * stallMs) / 60_000}m` }),
    merge: (pr) => mergePr(repo.root, pr, (method ??= repoMergeMethod(repo.root))),
    stop: (task, note) => stopWorker(repo, task, term, "budget", note),
    sync: () => {
      const r = sync(repo, base, term);
      for (const id of r.retargeted) logRun(repo, id, "pr-updated", `moved to ${base} by the watcher's sync`);
      return needsOrchestrator(repo, base, r);
    },
  };
  const watched = [join(repo.foreman, "tasks"), join(repo.root, ".git", "refs"), join(repo.root, ".git", "packed-refs")].filter(existsSync);
  const hasOrigin = run(["git", "-C", repo.root, "remote", "get-url", "origin"]).code === 0;

  try {
    for (;;) {
      if (signal?.aborted) return "watcher: stopped";
      // A reviewer that hits the limit records it itself, and the watcher pauses the workers on its next pass.
      const saved = cursor.limit ? undefined : loadLimit(repo);
      if (saved && saved.since > (cursor.limitEnded ?? 0)) cursor.limit = saved;
      const tasks = inFlight(loadTasks(repo));
      const ghDue = Date.now() - lastGh >= GH_POLL_MS;
      if (ghDue) lastGh = Date.now();
      // Merges happen on GitHub, so origin's base only moves here when it's fetched.
      if (ghDue && hasOrigin) run(["git", "-C", repo.root, "fetch", "-q", "origin", base]);
      const procs = new Map<string, Proc[]>();
      const live = tasks.filter((t) => existsSync(t.worktree));
      processesIn(live.map((t) => t.worktree)).forEach((list, i) => procs.set(live[i]!.id, list));
      const untidy = tidyAll(live, procs, cursor);
      let blocks: PermissionBlock[] = [];
      try {
        blocks = syncBlocks(repo, tasks);
      } catch {}
      const prs = trackedPrs(tasks, loadDecisions(repo)).filter((p) => !["MERGED", "CLOSED"].includes(cursor.prs?.[`${p.number}`]?.state ?? ""));
      const result = scan(tasks, cursor, { ...probes, pr: ghDue ? (n) => ghPr(repo.root, n) : undefined, processes: (t) => procs.get(t.id) ?? [], blocks: () => blocks }, prs, { now: Date.now(), stallMs, answerMs: answerMs(repo), waiting });
      cursor = result.cursor;
      for (const [id, patch] of prPatches(tasks, prs, cursor.prs ?? {})) updateTask(repo, id, patch);
      result.reasons.unshift(...untidy);
      saveLimit(repo, cursor.limit);
      // The next pass polls GitHub straight away, so the usual merged line wakes the orchestrator.
      if (applyPass(result, tasks, effects, Date.now())) lastGh = 0;
      if (cursor.limit) cursor.held = [...(cursor.held ?? []), ...result.reasons.splice(0)];
      writeFileSync(cursorFile, JSON.stringify(cursor));
      if (result.notice) notice?.(result.notice);
      if (result.reasons.length) return result.reasons.join("; ");
      if (lastGh) await wait(watched, POLL_MS, signal);
    }
  } finally {
    release(repo);
  }
}

// Only the watcher that armed may disarm, so a second one turned away can't clear the first one's pid.
function release(repo: Repo): void {
  const pidFile = join(repo.foreman, "watch.pid");
  if (readPid(pidFile) === process.pid) rmSync(pidFile, { force: true });
}

export const resumePrompt = (repo: Repo, id: string) =>
  `Foreman paused you while the account waited for its usage limit to reset, and it has reset now. Run git status to see where you left off, then carry on with your brief at ${join(taskDir(repo, id), "brief.md")}.`;

// Stops what each worktree's old runs left behind, and drops it from the pass's process lists so it can't make a worker look busy.
function tidyAll(tasks: Task[], procs: Map<string, Proc[]>, cursor: Cursor): string[] {
  const reasons: string[] = [];
  const unstoppable = new Set(cursor.unstoppable ?? []);
  for (const task of tasks) {
    const r = tidy(task, procs.get(task.id)!);
    const gone = new Set(r.stopped.map((p) => p.pid));
    procs.set(task.id, procs.get(task.id)!.filter((p) => !gone.has(p.pid)));
    // Reporting a process Foreman can't stop on every pass would wake the orchestrator every 30 seconds.
    const fresh = r.failed.filter((p) => !unstoppable.has(p.pid));
    if (fresh.length) reasons.push(`leftover ${task.id}: ${unstoppableLine(fresh)}`);
    for (const p of r.failed) unstoppable.add(p.pid);
  }
  cursor.unstoppable = [...unstoppable].filter(pidAlive);
  return reasons;
}

const waitForChange: WaitForChange = async (paths, ms, signal) => {
  if (signal?.aborted) return;
  const proc = Bun.spawn(["fswatch", "-1", "-r", "-l", "0.5", ...paths], { stdout: "ignore", stderr: "ignore" });
  let timer: Timer | undefined;
  let onAbort = () => {};
  const stopped = new Promise<void>((r) => signal?.addEventListener("abort", (onAbort = () => r()), { once: true }));
  await Promise.race([proc.exited, stopped, new Promise((r) => (timer = setTimeout(r, ms)))]);
  signal?.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  proc.kill();
};

export function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function watcherArmed(repo: Repo): boolean {
  const pid = readPid(join(repo.foreman, "watch.pid"));
  return pid !== undefined && pidAlive(pid);
}
