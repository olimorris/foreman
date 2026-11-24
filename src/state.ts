import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";
import type { Tab } from "./rex.ts";
import { withLock } from "./store.ts";

export type TaskStatus = "running" | "done" | "blocked" | "needs-decision" | "exited" | "pr-open" | "merged" | "torn-down";

export type Task = {
  id: string;
  title?: string;
  status: TaskStatus;
  branch: string;
  base: string;
  worktree: string;
  owns: string[];
  socket: string;
  rex?: Tab;
  pr?: number;
  startSha?: string;
  mergedAt?: string;
  rebaseAsked?: string;
  reviews?: number;
  revisions?: number;
  createdAt: string;
};

const tasksPath = (repo: Repo) => join(repo.foreman, "tasks.json");

export function loadTasks(repo: Repo): Task[] {
  const path = tasksPath(repo);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).tasks ?? [];
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

export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
