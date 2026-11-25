import { existsSync } from "node:fs";
import { join } from "node:path";
import { budgetLeft } from "./cost.ts";
import { loadSessions, sessionsFile } from "./transcripts.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { checkModel } from "./brief.ts";
import { onModel, tabLabel, workerCommand } from "./spawn.ts";
import { stopWorkerProcesses, workerTree } from "./procs.ts";
import { findTask, loadTasks, type Task } from "./state.ts";
import { activeLimit, limitLine } from "./limits.ts";
import { transition, type PauseWhy } from "./lifecycle.ts";
import { missedNotes } from "./notes.ts";

// Closing the tab kills the worker's Claude process, so it stops spending even if it would ignore a message.
export function stopWorker(repo: Repo, task: Task, term: Terminal, why: Exclude<PauseWhy, "limit"> = "user", note?: string): boolean {
  if (!task.tab || !term.alive(task.tab)) return false;
  closeWorker(task, term);
  transition(repo, task.id, { type: "paused", why, note });
  return true;
}

// Stops the worker's processes and what its old runs left, but never the user's own shell or a review open in the same worktree.
function closeWorker(task: Task, term: Terminal): void {
  const tree = workerTree(task);
  if (task.tab && term.alive(task.tab)) term.close(task.tab);
  stopWorkerProcesses(task, tree);
}

// The worker's uncommitted changes stay in its worktree, and resume carries on its last session.
export function pauseForLimit(repo: Repo, task: Task, term: Terminal, note?: string): void {
  closeWorker(task, term);
  transition(repo, task.id, { type: "paused", why: "limit", note });
}

export const resumedLine = (task: Task) => `resumed ${task.id}'s worker in a new tab${onModel(task)}`;
export const restartedLine = (task: Task) => `restarted ${task.id}'s worker in a new tab, carrying on its last session${onModel(task)}`;

export type Reopen = { model?: string; prompt?: string; note?: string };

export function restartWorker(repo: Repo, task: Task, term: Terminal, session: string, opts: Omit<Reopen, "prompt"> = {}): Task {
  if (opts.model !== undefined) checkModel(opts.model);
  closeWorker(task, term);
  return reopen(repo, task.id, term, session, opts, true);
}

export function resume(repo: Repo, id: string, term: Terminal, session: string, opts: Reopen = {}): Task {
  return reopen(repo, id, term, session, opts, false);
}

function reopen(repo: Repo, id: string, term: Terminal, session: string, { model, prompt, note }: Reopen, restarted: boolean): Task {
  if (model !== undefined) checkModel(model);
  const wait = activeLimit(repo);
  if (wait) throw new Error(`${limitLine(wait)}, and the watcher resumes ${id} then`);
  const task = { ...findTask(repo, id), ...(model !== undefined ? { model } : {}) };
  if (task.tab && term.alive(task.tab)) throw new Error(`${id}'s worker is still running`);
  if (!existsSync(task.worktree)) throw new Error(`${id}'s worktree is gone, so it can't resume. The orchestrator can tear it down with the teardown tool`);
  const left = budgetLeft(repo, loadTasks(repo), id);
  if (left.reason) throw new Error(`${left.reason}, then resume`);
  const last = loadSessions(sessionsFile(repo, id)).at(-1);
  const told = [prompt ?? `Foreman stopped you and has now restarted you. Run git status to see where you left off, then carry on with your brief at ${join(repo.foreman, "tasks", id, "brief.md")}.`, missedNotes(repo, task.pausedAt)];
  // The old worker is gone, and a test run it left holding the build folder's lock would hang the new worker's first build.
  closeWorker(task, term);
  const tab = term.open(session, tabLabel(task), task.worktree, workerCommand(task, term, told.filter(Boolean).join("\n\n"), last));
  return transition(repo, id, { type: "resumed", tab, model: task.model, restarted, note });
}
