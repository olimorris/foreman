import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "./exec.ts";
import { isInside, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { inFlight, loadTasks, type Task } from "./state.ts";
import { isMerged } from "./lifecycle.ts";
import { unmergedWork, type Unmerged } from "./teardown.ts";
import { baseRef } from "./base.ts";
import { stopProcessesIn } from "./procs.ts";
import { setTrust } from "./trust.ts";

export type RemoveResult = { removed: boolean; message: string };

export function orchestratorSessionName(repo: Repo): string {
  return `foreman-${basename(repo.root)}`;
}

// Uncommitted files are never in a merge, so they still count when the task is marked merged.
function lostWork(repo: Repo, task: Task): Unmerged {
  const work = unmergedWork(repo, task.branch, baseRef(repo, task.base), task.worktree);
  return isMerged(task) ? { commits: 0, dirty: work.dirty } : work;
}

function foremanWorktrees(repo: Repo): string[] {
  const list = run(["git", "-C", repo.root, "worktree", "list", "--porcelain"]).stdout;
  return list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length)).filter((p) => isInside(p, repo.foreman));
}

function foremanBranches(repo: Repo): string[] {
  return run(["git", "-C", repo.root, "for-each-ref", "--format=%(refname:short)", "refs/heads/foreman/"]).stdout.split("\n").filter(Boolean);
}

function dropExcludeLine(repo: Repo): boolean {
  const exclude = join(repo.root, ".git", "info", "exclude");
  if (!existsSync(exclude)) return false;
  const lines = readFileSync(exclude, "utf8").split("\n");
  const kept = lines.filter((l) => l !== ".foreman/");
  if (kept.length === lines.length) return false;
  writeFileSync(exclude, kept.join("\n"));
  return true;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function removeForeman(repo: Repo, discard: boolean, term: Terminal, opts: { cwd?: string; claudeConfig?: string } = {}): RemoveResult {
  const cwd = opts.cwd ?? process.cwd();
  // Removing the worktree the user is standing in would leave their shell in a deleted folder.
  if (isInside(cwd, repo.foreman)) return { removed: false, message: `Run foreman remove from ${repo.root}, not from inside .foreman/. Nothing was removed.` };

  const name = orchestratorSessionName(repo);
  if (term.findSession(name)) {
    return { removed: false, message: `The orchestrator is still running in ${term.name} session ${name}. Close that session, then run foreman remove again. Nothing was removed.` };
  }

  const tasks = inFlight(loadTasks(repo));
  const unmerged = tasks.map((t) => ({ id: t.id, lost: lostWork(repo, t) })).filter((t) => t.lost.commits || t.lost.dirty);
  if (unmerged.length && !discard) {
    const lines = unmerged.map((t) => `- ${t.id}: ${plural(t.lost.commits, "unmerged commit")} and ${plural(t.lost.dirty, "uncommitted file")}`);
    return {
      removed: false,
      message: [`These tasks have work that isn't merged:`, ...lines, `Nothing was removed. Merge or copy that work first, or run foreman remove --discard to lose it.`].join("\n"),
    };
  }

  for (const t of tasks) if (t.tab && term.alive(t.tab)) term.close(t.tab);
  const worktrees = foremanWorktrees(repo);
  for (const wt of worktrees) {
    stopProcessesIn(wt);
    run(["git", "-C", repo.root, "worktree", "remove", "--force", wt]);
    setTrust(wt, false, opts.claudeConfig);
  }
  const hadFolder = existsSync(repo.foreman);
  rmSync(repo.foreman, { recursive: true, force: true });
  run(["git", "-C", repo.root, "worktree", "prune"]);

  const deleted: string[] = [];
  const kept: string[] = [];
  for (const branch of foremanBranches(repo)) {
    const r = run(["git", "-C", repo.root, "branch", "-D", branch]);
    if (r.code === 0) deleted.push(branch);
    else kept.push(`Couldn't delete branch ${branch}: ${r.stderr.trim()}`);
  }
  const hadExclude = dropExcludeLine(repo);

  const gone = [
    ...(worktrees.length ? [`- ${plural(worktrees.length, "worktree")}`] : []),
    ...(hadFolder ? ["- the .foreman/ folder"] : []),
    ...(deleted.length ? [`- ${plural(deleted.length, "local branch", "local branches")}: ${deleted.join(", ")}`] : []),
    ...(hadExclude ? ["- the .foreman/ line in .git/info/exclude"] : []),
  ];
  const lines = gone.length ? [`Removed Foreman from ${repo.root}:`, ...gone] : [`Foreman had nothing left in ${repo.root} to remove.`];
  if (unmerged.length) lines.push(`Discarded the unmerged work in ${unmerged.map((t) => t.id).join(", ")}.`);
  lines.push(...kept, "Branches Foreman pushed and its PRs are still on GitHub, so close or delete those there.");
  return { removed: true, message: lines.join("\n") };
}
