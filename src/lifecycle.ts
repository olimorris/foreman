import { logRun, type ReportType, type RunWhat } from "./events.ts";
import type { Repo } from "./paths.ts";
import { withTasks, type Task, type TaskStatus } from "./state.ts";
import type { Tab } from "./terminal.ts";

// The user's pause reuses "over-budget", so only the run log tells it apart from a budget stop.
export type PauseWhy = "budget" | "user" | "limit";

export type Event =
  | { type: "reported"; report: ReportType }
  | { type: "messaged" }
  | { type: "feedback" }
  | { type: "pr-opened"; pr: number }
  | { type: "merged" }
  | { type: "paused"; why: PauseWhy; note?: string }
  | { type: "resumed"; tab: Tab; model?: string; restarted?: boolean; note?: string }
  | { type: "torn-down"; note?: string };

export const isFinished = (t: Pick<Task, "status">) => t.status === "merged" || t.status === "torn-down";
export const isMerged = (t: Pick<Task, "status" | "mergedAt">) => !!t.mergedAt || t.status === "merged";
// A finished task gives its worker slot back, and so does its worker number.
export const holdsSlot = (t: Pick<Task, "status">) => !isFinished(t);
export const isPaused = (t: Pick<Task, "status">) => t.status === "over-budget" || t.status === "limited";

const NEEDS_USER: TaskStatus[] = ["needs-decision", "blocked", "exited", "over-budget", "pr-open"];
export const needsUser = (t: Pick<Task, "status">) => NEEDS_USER.includes(t.status);

// Foreman closed these workers' tabs itself, or saw them close, so their sessions are gone until a resume.
const CLOSED: TaskStatus[] = ["exited", "over-budget", "limited", "torn-down"];
export const tabOpen = (t: Pick<Task, "status" | "tab">) => !!t.tab && !CLOSED.includes(t.status);
export const canHear = (t: Pick<Task, "status" | "tab">) => tabOpen(t) && !isFinished(t);

// Numbers go back into use once a task finishes, so the crew reads as W1 to W3 when three workers run at once.
export function nextWorker(tasks: Task[]): string {
  const busy = new Set(tasks.filter((t) => t.worker && holdsSlot(t)).map((t) => t.worker));
  let n = 1;
  while (busy.has(`W${n}`)) n++;
  return `W${n}`;
}

const PAUSED_AS: Record<PauseWhy, TaskStatus> = { budget: "over-budget", user: "over-budget", limit: "limited" };

export function next(task: Task, event: Event, now = new Date()): Partial<Task> {
  if (task.status === "torn-down") throw new Error(`${task.id} is torn down, so it can't be ${event.type}`);
  switch (event.type) {
    case "reported":
      return event.report === "rebased" ? {} : { status: event.report };
    // A blocked worker that gets an answer is working again.
    case "messaged":
      return task.status === "blocked" || task.status === "needs-decision" ? { status: "running" } : {};
    case "feedback":
      return { status: "running", revisions: (task.revisions ?? 0) + 1 };
    case "pr-opened":
      return { status: "pr-open", pr: event.pr };
    case "merged":
      return { status: "merged", mergedAt: now.toISOString() };
    case "paused": {
      const status = PAUSED_AS[event.why];
      if (task.status === status) return {};
      // A worker paused twice still resumes to what it was doing before the first pause.
      return isPaused(task) ? { status } : { status, pausedFrom: task.status, pausedAt: now.toISOString() };
    }
    case "resumed":
      return { tab: event.tab, ...(event.model !== undefined ? { model: event.model } : {}), status: task.pausedFrom ?? "running", pausedFrom: undefined, pausedAt: undefined };
    case "torn-down":
      return { status: "torn-down" };
  }
}

function logged(task: Task, event: Event): [RunWhat, string | undefined] | undefined {
  switch (event.type) {
    case "pr-opened":
      return ["pr-opened", `#${event.pr}`];
    case "merged":
      return ["merged", task.pr ? `#${task.pr}` : undefined];
    case "paused":
      return [event.why === "budget" ? "stopped" : "paused", event.note];
    case "resumed":
      return [event.restarted ? "restarted" : "resumed", event.note];
    case "torn-down":
      return ["torn-down", event.note];
    default:
      return undefined;
  }
}

export function transition(repo: Repo, id: string, event: Event, now = new Date()): Task {
  const task = withTasks(repo, (tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no task ${id}`);
    return Object.assign(task, next(task, event, now));
  });
  const log = logged(task, event);
  if (log) logRun(repo, id, log[0], log[1]);
  return task;
}
