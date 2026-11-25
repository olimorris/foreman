import { join } from "node:path";
import type { Repo } from "./paths.ts";
import type { Tab } from "./terminal.ts";
import { jsonStore } from "./store.ts";
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
  pausedAt?: string;
  reviews?: number;
  revisions?: number;
  createdAt: string;
};

const tasksStore = (repo: Repo) => jsonStore<{ tasks: Task[] }>(join(repo.foreman, "tasks.json"), () => ({ tasks: [] }));

export function loadTasks(repo: Repo): Task[] {
  return (tasksStore(repo).read().tasks ?? []).map(upgrade);
}

// Tasks saved before terminal integrations kept their Rex tab under "rex", with the pane called a block.
function upgrade(task: Task & { rex?: { session: string; window: string; block: string } }): Task {
  const { rex, ...rest } = task;
  return rex && !rest.tab ? { ...rest, tab: { session: rex.session, window: rex.window, pane: rex.block } } : rest;
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
  return tasksStore(repo).update((saved) => {
    saved.tasks = (saved.tasks ?? []).map(upgrade);
    return fn(saved.tasks);
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

