import { existsSync } from "node:fs";
import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { findTask, updateTask } from "./state.ts";
import { setTrust } from "./trust.ts";
import { baseRef } from "./snapshot.ts";
import { logRun } from "./events.ts";
import { stopProcessesIn } from "./procs.ts";

export type Unmerged = { commits: number; dirty: number };

export function unmergedWork(repo: Repo, branch: string, base: string, worktree: string): Unmerged {
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  const merged = git("merge-base", "--is-ancestor", branch, base).code === 0;
  const commits = merged ? 0 : Number(git("rev-list", "--count", `${base}..${branch}`).stdout.trim()) || 0;
  const dirty = existsSync(worktree)
    ? run(["git", "-C", worktree, "status", "--porcelain"]).stdout.split("\n").filter(Boolean).length
    : 0;
  return { commits, dirty };
}

export type TeardownResult = { removed: boolean; message: string };

export function teardown(repo: Repo, id: string, discard: boolean, term: Terminal, claudeConfig?: string): TeardownResult {
  const task = findTask(repo, id);
  const work = unmergedWork(repo, task.branch, baseRef(repo, task.base), task.worktree);
  // Uncommitted files are never in a merge, so they still count when the task is marked merged.
  const lost = task.mergedAt ? { commits: 0, dirty: work.dirty } : work;
  if ((lost.commits || lost.dirty) && !discard) {
    return {
      removed: false,
      message: `${id} has ${lost.commits} unmerged commit(s) and ${lost.dirty} uncommitted file(s). Nothing was removed. Ask the user, and only if they agree, call teardown for ${id} with discard`,
    };
  }
  if (task.tab) term.close(task.tab);
  stopProcessesIn(task.worktree);
  if (existsSync(task.worktree)) {
    const r = run(["git", "-C", repo.root, "worktree", "remove", ...(discard ? ["--force"] : []), task.worktree]);
    if (r.code !== 0) return { removed: false, message: `git worktree remove failed: ${r.stderr.trim()}` };
  }
  // A squash-merged branch isn't in the base's history, so -d would refuse it.
  run(["git", "-C", repo.root, "branch", discard || task.mergedAt ? "-D" : "-d", task.branch]);
  setTrust(task.worktree, false, claudeConfig);
  updateTask(repo, id, { status: "torn-down" });
  logRun(repo, id, "torn-down", lost.commits || lost.dirty ? "unmerged work discarded" : undefined);
  return { removed: true, message: `${id}: closed the worker tab, removed ${task.worktree} and branch ${task.branch}` };
}
