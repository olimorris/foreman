import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { baseRef } from "./base.ts";
import { loadTasks, updateTask, type Task } from "./state.ts";
import { isFinished, isMerged as markedMerged, transition } from "./lifecycle.ts";

export type SyncProbes = {
  fetch(base: string): void;
  prState(n: number): string | undefined;
  prBase(n: number): string | undefined;
  setPrBase(n: number, base: string): boolean;
};

export type SyncResult = { head: string; merged: string[]; mergedEarly: string[]; asked: string[]; failed: string[]; retargeted: string[] };

export const realProbes = (repo: Repo): SyncProbes => {
  const gh = (...args: string[]) => run(["gh", "pr", ...args], { cwd: repo.root });
  const field = (n: number, name: string) => {
    const r = gh("view", String(n), "--json", name, "-q", `.${name}`);
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  return {
    fetch: (base) => void run(["git", "-C", repo.root, "fetch", "-q", "origin", base]),
    prState: (n) => field(n, "state"),
    prBase: (n) => field(n, "baseRefName"),
    setPrBase: (n, base) => gh("edit", String(n), "--base", base).code === 0,
  };
};

// Squash merges leave the branch outside the base's history, so the PR's own state is checked first.
export function isMerged(repo: Repo, task: Task, ref: string, prState?: string): boolean {
  if (prState === "MERGED") return true;
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  const own = workerCommitted(repo, task.branch) ?? commitsSinceStart(repo, task, ref) > 0;
  return own && git("merge-base", "--is-ancestor", task.branch, ref).code === 0;
}

// A worker that rebases before its first commit moves its branch onto base commits, which looks exactly like a fast-forward merge, so only the branch's reflog can tell whether the worker committed anything.
export function workerCommitted(repo: Repo, branch: string): boolean | undefined {
  const r = run(["git", "-C", repo.root, "reflog", "show", "--format=%gs", `refs/heads/${branch}`]);
  const entries = r.stdout.split("\n").filter(Boolean);
  if (r.code !== 0 || !entries.length) return undefined;
  return entries.some((e) => /^(commit|cherry-pick|merge)\b/.test(e));
}

function commitsSinceStart(repo: Repo, task: Task, ref: string): number {
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  const from = task.startSha ?? git("merge-base", task.branch, ref).stdout.trim();
  return Number(git("rev-list", "--count", `${from}..${task.branch}`).stdout.trim()) || 0;
}

const RESOLVE = "Resolve conflicts only within your owned paths. If one needs a change elsewhere, abort the rebase and report blocked.";
const REPORT = "Rerun your checks, then call the report tool with type rebased and one line.";

export function sync(repo: Repo, base: string, term: Terminal, probes: SyncProbes = realProbes(repo)): SyncResult {
  if (run(["git", "-C", repo.root, "remote", "get-url", "origin"]).code === 0) probes.fetch(base);
  const ref = baseRef(repo, base);
  const head = run(["git", "-C", repo.root, "rev-parse", ref]).stdout.trim();
  const result: SyncResult = { head, merged: [], mergedEarly: [], asked: [], failed: [], retargeted: [] };
  const open = loadTasks(repo).filter((t) => !isFinished(t));
  const markMerged = (task: Task) => {
    transition(repo, task.id, { type: "merged" });
    result.merged.push(task.id);
  };

  for (const task of open.filter((t) => !t.mergedInto)) {
    const state = task.pr ? probes.prState(task.pr) : undefined;
    if (state && (state === "CLOSED") !== !!task.prClosed) updateTask(repo, task.id, { prClosed: state === "CLOSED" || undefined });
    // A stacked PR merged into its parent's branch hasn't reached the base, so tearing its task down would lose track of it.
    const into = state === "MERGED" ? probes.prBase(task.pr!) : undefined;
    if (into && into !== base) {
      updateTask(repo, task.id, { mergedInto: into });
      result.mergedEarly.push(task.id);
    } else if (isMerged(repo, task, ref, state)) markMerged(task);
  }
  for (const task of loadTasks(repo).filter((t) => t.mergedInto && !isFinished(t))) {
    if (loadTasks(repo).some((t) => t.branch === task.mergedInto && markedMerged(t))) markMerged(task);
  }

  const ask = (task: Task, text: string, patch: Partial<Task>) => {
    try {
      sendToTask(repo, task, text, term);
      updateTask(repo, task.id, patch);
      result.asked.push(task.id);
      return true;
    } catch {
      result.failed.push(task.id);
      return false;
    }
  };

  const mergedNote = result.merged.length ? `, which now includes ${result.merged.join(", ")}` : "";
  const retarget = (task: Task) => {
    // GitHub moves the PR itself when the parent's branch is deleted on merge, and leaves it on the old branch otherwise.
    if (task.pr && probes.prBase(task.pr) !== base && probes.setPrBase(task.pr, base)) result.retargeted.push(task.id);
  };
  const tasks = loadTasks(repo);
  for (const task of open) {
    if (result.merged.includes(task.id) || result.mergedEarly.includes(task.id) || task.mergedInto || task.status === "exited") continue;
    const parent = tasks.find((t) => t.id === task.stackedOn);
    if (parent && markedMerged(parent)) {
      if (!moveOff(repo, base, ref, head, task, parent, ask, retarget)) continue;
    } else if (parent && parent.status !== "torn-down") {
      follow(repo, task, parent, ask);
      continue;
    } else if (task.stackedOn) {
      // The user kept this task when its parent was dropped, so it carries the parent's commits onto the base like its own.
      updateTask(repo, task.id, { stackedOn: undefined, parentSha: undefined });
      retarget(task);
    }
    if (task.rebaseAsked === head) continue;
    if (run(["git", "-C", repo.root, "merge-base", "--is-ancestor", head, task.branch]).code === 0) continue;
    const text = [
      `${base} moved to ${head.slice(0, 8)}${mergedNote}.`,
      `At your next safe point, commit your work and run \`git rebase ${ref}\` in your worktree.`,
      RESOLVE,
      REPORT,
    ].join(" ");
    ask(task, text, { rebaseAsked: head });
  }
  return result;
}

type Ask = (task: Task, text: string, patch: Partial<Task>) => boolean;

const isAncestor = (repo: Repo, a: string, b: string) => run(["git", "-C", repo.root, "merge-base", "--is-ancestor", a, b]).code === 0;

// The worker may already have rebased onto the parent's newer commits, and replaying from an older tip would repeat them.
function basedOn(repo: Repo, task: Task, parent: Task): string {
  const tip = run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", parent.branch]).stdout.trim();
  return tip && isAncestor(repo, tip, task.branch) ? tip : task.parentSha ?? task.startSha!;
}

function follow(repo: Repo, task: Task, parent: Task, ask: Ask): void {
  const tip = run(["git", "-C", repo.root, "rev-parse", "--verify", "-q", parent.branch]).stdout.trim();
  const from = basedOn(repo, task, parent);
  if (from === tip) {
    if (task.parentSha !== tip) updateTask(repo, task.id, { parentSha: tip });
    return;
  }
  if (task.rebaseAsked === tip) return;
  const text = [
    `${parent.id}'s branch, which yours builds on, has new commits.`,
    `At your next safe point, commit your work and run \`git rebase --onto ${parent.branch} ${from}\` in your worktree.`,
    RESOLVE,
    REPORT,
  ].join(" ");
  ask(task, text, { rebaseAsked: tip });
}

// Until the worker has rebased, a review or delivery against the base would show the parent's commits as this task's change.
// Returns true once the task is off its parent, so the caller treats it like any other task.
function moveOff(repo: Repo, base: string, ref: string, head: string, task: Task, parent: Task, ask: Ask, retarget: (task: Task) => void): boolean {
  const from = basedOn(repo, task, parent);
  // A move of the base after the rebase leaves the head outside the branch, so the old parent tip being gone counts as moved too.
  if (isAncestor(repo, head, task.branch) || !isAncestor(repo, from, task.branch)) {
    updateTask(repo, task.id, { stackedOn: undefined, parentSha: undefined });
    retarget(task);
    return true;
  }
  if (task.rebaseAsked === head) return false;
  const text = [
    `${parent.id} merged into ${base}, so your branch now goes onto ${base} directly.`,
    `At your next safe point, commit your work and run \`git rebase --onto ${ref} ${from}\` in your worktree.`,
    `That replays only your own commits, because a squash merge leaves ${parent.id}'s commits outside ${base}.`,
    RESOLVE,
    REPORT,
  ].join(" ");
  ask(task, text, { rebaseAsked: head });
  return false;
}
