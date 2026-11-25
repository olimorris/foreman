import { existsSync } from "node:fs";
import { join } from "node:path";
import { budgetLeft, loadSessions, sessionsFile } from "./cost.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { checkModel, tabLabel, workerCommand } from "./spawn.ts";
import { stopWorkerProcesses, workerTree } from "./procs.ts";
import { findTask, loadTasks, updateTask, type Task } from "./state.ts";
import { activeLimit, limitLine } from "./limits.ts";

// Closing the tab kills the worker's Claude process, so it stops spending even if it would ignore a message.
export function stopWorker(repo: Repo, task: Task, term: Terminal): boolean {
  if (!task.tab || !term.alive(task.tab)) return false;
  closeWorker(task, term);
  if (task.status !== "over-budget") updateTask(repo, task.id, { status: "over-budget", pausedFrom: task.status });
  return true;
}

// Stops the worker's processes and what its old runs left, but never the user's own shell or a review open in the same worktree.
function closeWorker(task: Task, term: Terminal): void {
  const tree = workerTree(task);
  if (task.tab && term.alive(task.tab)) term.close(task.tab);
  stopWorkerProcesses(task, tree);
}

// The worker's uncommitted changes stay in its worktree, and resume carries on its last session.
export function pauseForLimit(repo: Repo, task: Task, term: Terminal): void {
  closeWorker(task, term);
  updateTask(repo, task.id, { status: "limited", pausedFrom: task.status });
}

export function restartWorker(repo: Repo, task: Task, term: Terminal, session: string, model?: string): Task {
  if (model !== undefined) checkModel(model);
  closeWorker(task, term);
  return resume(repo, task.id, term, session, model);
}

export function resume(repo: Repo, id: string, term: Terminal, session: string, model?: string, prompt?: string): Task {
  if (model !== undefined) checkModel(model);
  const wait = activeLimit(repo);
  if (wait) throw new Error(`${limitLine(wait)}, and the watcher resumes ${id} then`);
  const task = { ...findTask(repo, id), ...(model !== undefined ? { model } : {}) };
  if (task.tab && term.alive(task.tab)) throw new Error(`${id}'s worker is still running`);
  if (!existsSync(task.worktree)) throw new Error(`${id}'s worktree is gone, so it can't resume. The orchestrator can tear it down with the teardown tool`);
  const left = budgetLeft(repo, loadTasks(repo), id);
  if (left.reason) throw new Error(`${left.reason}, then resume`);
  const last = loadSessions(sessionsFile(repo, id)).at(-1);
  prompt ??= `Foreman stopped you and has now restarted you. Run git status to see where you left off, then carry on with your brief at ${join(repo.foreman, "tasks", id, "brief.md")}.`;
  // The old worker is gone, and a test run it left holding the build folder's lock would hang the new worker's first build.
  closeWorker(task, term);
  const tab = term.open(session, tabLabel(task), task.worktree, workerCommand(task, term, prompt, last));
  return updateTask(repo, id, { tab, model: task.model, status: task.pausedFrom ?? "running", pausedFrom: undefined });
}
