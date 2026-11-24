import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import type { Rex } from "./rex.ts";
import { sendToTask } from "./send.ts";
import { baseRef } from "./snapshot.ts";
import { inFlight, loadTasks, updateTask, type Task } from "./state.ts";

export type SyncProbes = { fetch(base: string): void; prState(n: number): string | undefined };

export type SyncResult = { head: string; merged: string[]; asked: string[]; failed: string[] };

export const realProbes = (repo: Repo): SyncProbes => ({
  fetch: (base) => void run(["git", "-C", repo.root, "fetch", "-q", "origin", base]),
  prState: (n) => {
    const r = run(["gh", "pr", "view", String(n), "--json", "state", "-q", ".state"], { cwd: repo.root });
    return r.code === 0 ? r.stdout.trim() : undefined;
  },
});

// Squash merges leave the branch outside the base's history, so the PR's own state is checked first.
export function isMerged(repo: Repo, task: Task, ref: string, prState?: string): boolean {
  if (prState === "MERGED") return true;
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  const from = task.startSha ?? git("merge-base", task.branch, ref).stdout.trim();
  const commits = Number(git("rev-list", "--count", `${from}..${task.branch}`).stdout.trim()) || 0;
  return commits > 0 && git("merge-base", "--is-ancestor", task.branch, ref).code === 0;
}

export function sync(repo: Repo, base: string, rex: Rex, probes: SyncProbes = realProbes(repo)): SyncResult {
  if (run(["git", "-C", repo.root, "remote", "get-url", "origin"]).code === 0) probes.fetch(base);
  const ref = baseRef(repo, base);
  const head = run(["git", "-C", repo.root, "rev-parse", ref]).stdout.trim();
  const result: SyncResult = { head, merged: [], asked: [], failed: [] };
  const open = inFlight(loadTasks(repo)).filter((t) => !t.mergedAt);

  for (const task of open) {
    if (!isMerged(repo, task, ref, task.pr ? probes.prState(task.pr) : undefined)) continue;
    updateTask(repo, task.id, { mergedAt: new Date().toISOString(), status: "merged" });
    result.merged.push(task.id);
  }

  const mergedNote = result.merged.length ? `, which now includes ${result.merged.join(", ")}` : "";
  for (const task of open) {
    if (result.merged.includes(task.id) || task.status === "exited" || task.rebaseAsked === head) continue;
    if (run(["git", "-C", repo.root, "merge-base", "--is-ancestor", head, task.branch]).code === 0) continue;
    const text = [
      `${base} moved to ${head.slice(0, 8)}${mergedNote}.`,
      `At your next safe point, commit your work and run \`git rebase ${ref}\` in your worktree.`,
      "Resolve conflicts only within your owned paths. If one needs a change elsewhere, abort the rebase and report blocked.",
      `Rerun your checks, then run \`foreman report rebased "<one line>"\`.`,
    ].join(" ");
    try {
      sendToTask(repo, task, text, rex);
      updateTask(repo, task.id, { rebaseAsked: head });
      result.asked.push(task.id);
    } catch {
      result.failed.push(task.id);
    }
  }
  return result;
}
