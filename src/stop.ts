import { existsSync } from "node:fs";
import { join } from "node:path";
import { budgetLeft, loadSessions, sessionsFile } from "./cost.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { tabLabel, workerCommand } from "./spawn.ts";
import { findTask, loadTasks, updateTask, type Task } from "./state.ts";

// Closing the tab kills the worker's Claude process, so it stops spending even if it would ignore a message.
export function stopWorker(repo: Repo, task: Task, term: Terminal): boolean {
  if (!task.tab || !term.alive(task.tab)) return false;
  term.close(task.tab);
  if (task.status !== "over-budget") updateTask(repo, task.id, { status: "over-budget", pausedFrom: task.status });
  return true;
}

export function restartWorker(repo: Repo, task: Task, term: Terminal, session: string): Task {
  if (task.tab && term.alive(task.tab)) term.close(task.tab);
  return resume(repo, task.id, term, session);
}

export function resume(repo: Repo, id: string, term: Terminal, session: string): Task {
  const task = findTask(repo, id);
  if (task.tab && term.alive(task.tab)) throw new Error(`${id}'s worker is still running`);
  if (!existsSync(task.worktree)) throw new Error(`${id}'s worktree is gone, so it can't resume. Tear it down with foreman teardown ${id}`);
  const left = budgetLeft(repo, loadTasks(repo), id);
  if (left.reason) throw new Error(`${left.reason}, then resume`);
  const last = loadSessions(sessionsFile(repo, id)).at(-1);
  const prompt = `Foreman stopped you and has now restarted you. Run git status to see where you left off, then carry on with your brief at ${join(repo.foreman, "tasks", id, "brief.md")}.`;
  const tab = term.open(session, tabLabel(task), task.worktree, workerCommand(task, term, prompt, last));
  return updateTask(repo, id, { tab, status: task.pausedFrom ?? "running", pausedFrom: undefined });
}
