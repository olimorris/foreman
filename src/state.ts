import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";
import type { Tab } from "./terminal.ts";
import { withLock } from "./store.ts";
import { baseRef } from "./snapshot.ts";

export type TaskStatus = "running" | "over-budget" | "limited" | "done" | "blocked" | "needs-decision" | "exited" | "pr-open" | "merged" | "torn-down";

export type Task = {
  id: string;
  title?: string;
  worker?: string;
  model?: string;
  status: TaskStatus;
  branch: string;
  base: string;
  worktree: string;
  owns: string[];
  socket: string;
  tab?: Tab;
  pr?: number;
  startSha?: string;
  stackedOn?: string;
  parentSha?: string;
  prClosed?: boolean;
  mergedInto?: string;
  mergedAt?: string;
  rebaseAsked?: string;
  pausedFrom?: TaskStatus;
  reviews?: number;
  revisions?: number;
  createdAt: string;
};

const tasksPath = (repo: Repo) => join(repo.foreman, "tasks.json");

export function loadTasks(repo: Repo): Task[] {
  const path = tasksPath(repo);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")).tasks ?? []).map(upgrade);
}

// Tasks saved before terminal integrations kept their Rex tab under "rex", with the pane called a block.
function upgrade(task: Task & { rex?: { session: string; window: string; block: string } }): Task {
  const { rex, ...rest } = task;
  return rex && !rest.tab ? { ...rest, tab: { session: rex.session, window: rex.window, pane: rex.block } } : rest;
}

// Numbers go back into use once a task merges or is torn down, so the crew reads as W1 to W3 when three workers run at once.
export function nextWorker(tasks: Task[]): string {
  const busy = new Set(tasks.filter((t) => t.worker && t.status !== "torn-down" && t.status !== "merged").map((t) => t.worker));
  let n = 1;
  while (busy.has(`W${n}`)) n++;
  return `W${n}`;
}

export function findTask(repo: Repo, id: string): Task {
  const task = loadTasks(repo).find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

export function inFlight(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status !== "torn-down");
}

export function withTasks<T>(repo: Repo, fn: (tasks: Task[]) => T): T {
  mkdirSync(repo.foreman, { recursive: true });
  return withLock(join(repo.foreman, "tasks.lock"), () => {
    const tasks = loadTasks(repo);
    const result = fn(tasks);
    writeJson(tasksPath(repo), { tasks });
    return result;
  });
}

export function updateTask(repo: Repo, id: string, patch: Partial<Task>): Task {
  return withTasks(repo, (tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no task ${id}`);
    Object.assign(task, patch);
    return task;
  });
}

// A stacked task's own change is what it adds on top of its parent's branch, so diffs against the base would show the parent's work too.
export function diffBase(repo: Repo, task: Task): string {
  if (!task.stackedOn) return baseRef(repo, task.base);
  const parent = loadTasks(repo).find((t) => t.id === task.stackedOn);
  return parent && parent.status !== "torn-down" ? parent.branch : task.parentSha ?? baseRef(repo, task.base);
}

export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
