import { loadConfig, neverRules } from "./config.ts";
import { run } from "./exec.ts";
import { usageError } from "./help.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, planPath } from "./plan.ts";
import { latestVerdict } from "./review.ts";
import { writeJson, type Task } from "./state.ts";

export type Check = { name: string; state: "pass" | "fail" | "pending" };
export type PrView = { state: string; base?: string; head?: string; sha?: string; draft?: boolean; checks?: Check[] };
export type MergeCall = "merge" | "wait" | { failing: string[] };
export type Merge = { id: string; number: number; sha: string };

export const automergeOn = (repo: Repo): boolean => loadPlan(repo)?.automerge === true;

export const approved = (repo: Repo, task: Task): boolean => latestVerdict(repo, task)?.verdict === "approve";

export function mergeCall(task: Task, pr: PrView, isApproved: boolean): MergeCall {
  if (!isApproved || task.status !== "pr-open" || pr.state !== "OPEN" || pr.draft || !pr.sha) return "wait";
  // Release-please's PR, the decisions PR and anything the user opened all live on other branches.
  if (pr.head !== `foreman/${task.id}`) return "wait";
  // A PR stacked on another task's branch would merge into that branch, not ship.
  if (!pr.base || pr.base !== task.base) return "wait";
  const checks = pr.checks ?? [];
  const failing = checks.filter((c) => c.state === "fail").map((c) => c.name);
  if (failing.length) return { failing };
  return checks.some((c) => c.state === "pending") ? "wait" : "merge";
}

type Rollup = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string };

const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];

// gh mixes GitHub Actions check runs with the older commit statuses, and they spell their results differently.
export function checksOf(rollup: Rollup[] = []): Check[] {
  return rollup.map((c) => {
    const name = c.name || c.context || "an unnamed check";
    if (c.__typename === "StatusContext") return { name, state: c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail" };
    if (c.status !== "COMPLETED") return { name, state: "pending" };
    return { name, state: PASSED.includes(c.conclusion ?? "") ? "pass" : "fail" };
  });
}

export type MergeMethod = "squash" | "merge" | "rebase";
export type Allowed = { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean };

export function mergeMethod(allowed: Allowed): MergeMethod {
  if (allowed.squashMergeAllowed) return "squash";
  if (allowed.mergeCommitAllowed) return "merge";
  return allowed.rebaseMergeAllowed ? "rebase" : "squash";
}

export function repoMergeMethod(root: string): MergeMethod {
  const r = run(["gh", "repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], { cwd: root });
  try {
    return mergeMethod(r.code === 0 ? JSON.parse(r.stdout) : {});
  } catch {
    return "squash";
  }
}

// Returns why the merge failed, or undefined once it merged.
export function mergePr(root: string, pr: Merge, method: MergeMethod): string | undefined {
  // A push after the checks ran would otherwise merge code nobody checked.
  const r = run(["gh", "pr", "merge", String(pr.number), `--${method}`, "--match-head-commit", pr.sha], { cwd: root });
  if (r.code === 0) return undefined;
  return (r.stderr || r.stdout).trim().split("\n")[0] || `gh pr merge exited with ${r.code}`;
}

const ON = "Automerge is on until this plan finishes. Foreman merges each task's PR once the reviewer approves it and every check passes. Release PRs, the decisions PR and any PR Foreman didn't open stay with you";
const OFF = "Automerge is off. You merge every PR yourself";

export function automerge(repo: Repo, args: string[]): string[] {
  const [arg, ...extra] = args;
  if (extra.length || (arg !== undefined && arg !== "on" && arg !== "off")) throw usageError("automerge");
  const plan = loadPlan(repo);
  if (arg === undefined) return [plan?.automerge ? ON : OFF];
  if (!plan) throw new Error("no plan. This switches it for the current plan, and the orchestrator stores one with the plan tool");
  // Stored on the plan, not in config.json, so the next plan starts with it off.
  writeJson(planPath(repo), { ...plan, automerge: arg === "on" });
  if (arg === "off") return [OFF];
  const merging = neverRules(loadConfig(repo)).filter((r) => /merg/i.test(r));
  return [ON, ...(merging.length ? ["Your never list mentions merging, and it still applies:", ...merging.map((r) => `  - ${r}`)] : [])];
}
