import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import { loadTasks, type Task } from "./state.ts";

// Origin's copy is used when there is one, because the user's local branch lags behind merged PRs and may carry local edits.
export function baseRef(repo: Repo, base: string): string {
  const remote = `refs/remotes/origin/${base}`;
  return run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", remote]).code === 0 ? `origin/${base}` : base;
}

// A stacked task's own change is what it adds on top of its parent's branch, so diffs against the base would show the parent's work too.
export function diffBase(repo: Repo, task: Task): string {
  if (!task.stackedOn) return baseRef(repo, task.base);
  const parent = loadTasks(repo).find((t) => t.id === task.stackedOn);
  return parent && parent.status !== "torn-down" ? parent.branch : task.parentSha ?? baseRef(repo, task.base);
}
