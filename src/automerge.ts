import { loadConfig, neverRules } from "./config.ts";
import { run } from "./exec.ts";
import { usageError } from "./help.ts";
import type { Repo } from "./paths.ts";
import { loadPlan, updatePlan } from "./plan.ts";
import { latest, type Verdict } from "./rounds.ts";
import type { Task } from "./state.ts";

export type Check = { name: string; state: "pass" | "fail" | "pending" };
export type PrView = { state: string; base?: string; head?: string; sha?: string; draft?: boolean; checks?: Check[] };
export type Risk = Verdict["risk"];
export type MergeCall = "merge" | "wait" | "no-checks" | { failing: string[] } | { tooRisky: Risk };
export type MergeRules = { allowNoChecks?: boolean; maxRisk?: Risk };
export type Merge = { id: string; number: number; sha: string };

export const automergeOn = (repo: Repo): boolean => loadPlan(repo)?.automerge === true;

export const allowNoChecks = (repo: Repo): boolean => loadConfig(repo).automerge?.allowNoChecks === true;

const RISKS: Risk[] = ["low", "medium", "high"];

// A hand-typed level Foreman doesn't know falls back to the default, so a typo never lets riskier PRs merge.
export function maxRisk(repo: Repo): Risk {
  const level = loadConfig(repo).automerge?.maxRisk;
  return level && RISKS.includes(level) ? level : "low";
}

// The reviewer fills a missing risk with medium, so an old verdict without one counts as medium here too.
export const aboveRisk = (risk: Risk | undefined, max: Risk): boolean => RISKS.indexOf(risk ?? "medium") > RISKS.indexOf(max);

export type LatestVerdict = Pick<Verdict, "verdict"> & { risk?: Risk };

export const latestVerdict = (repo: Repo, task: Task): LatestVerdict | undefined => latest(repo, task)?.verdict;

// What status and the pane say about an approved PR that automerge leaves for the user because of its risk.
export function riskHold(verdict: LatestVerdict | undefined, max: Risk): string | undefined {
  if (verdict?.verdict !== "approve" || !aboveRisk(verdict.risk, max)) return undefined;
  return `waits for you: risk ${verdict.risk ?? "medium"} is above maxRisk ${max}`;
}

export function mergeCall(task: Task, pr: PrView, verdict: LatestVerdict | undefined, rules: MergeRules = {}): MergeCall {
  if (verdict?.verdict !== "approve" || task.status !== "pr-open" || pr.state !== "OPEN" || pr.draft || !pr.sha) return "wait";
  // Release-please's PR, the decisions PR and anything the user opened all live on other branches.
  if (pr.head !== `foreman/${task.id}`) return "wait";
  // A PR stacked on another task's branch would merge into that branch, not ship.
  if (!pr.base || pr.base !== task.base) return "wait";
  const call = checksCall(pr.checks ?? [], rules.allowNoChecks ?? false);
  // Failing checks still go back to the worker first, so the user isn't handed a PR that a worker could fix.
  if (call !== "merge" && call !== "no-checks") return call;
  const max = rules.maxRisk ?? "low";
  return aboveRisk(verdict.risk, max) ? { tooRisky: verdict.risk ?? "medium" } : call;
}

function checksCall(checks: Check[], allowNoChecks: boolean): MergeCall {
  // Nothing has checked the code, and a repo whose CI hasn't registered its checks yet looks the same as one with no CI.
  if (!checks.length) return allowNoChecks ? "merge" : "no-checks";
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

const RISK_LINES: Record<Risk, string> = {
  low: "It only merges PRs the reviewer rated low risk. Medium and high risk PRs stay with you",
  medium: "It merges PRs the reviewer rated low or medium risk. High risk PRs stay with you",
  high: "It merges PRs at any risk the reviewer gives",
};

const riskLine = (max: Risk): string => `${RISK_LINES[max]}. Set automerge.maxRisk in .foreman/config.json to change the level`;

export function automerge(repo: Repo, args: string[]): string[] {
  const [arg, ...extra] = args;
  if (extra.length || (arg !== undefined && arg !== "on" && arg !== "off")) throw usageError("automerge");
  if (arg === undefined) return automergeOn(repo) ? [ON, riskLine(maxRisk(repo))] : [OFF];
  // Stored on the plan, not in config.json, so the next plan starts with it off.
  updatePlan(repo, (plan) => {
    if (!plan) throw new Error("no plan. This switches it for the current plan, and the orchestrator stores one with the plan tool");
    return { ...plan, automerge: arg === "on" };
  });
  if (arg === "off") return [OFF];
  const merging = neverRules(loadConfig(repo)).filter((r) => /merg/i.test(r));
  const noChecks = allowNoChecks(repo) ? ["automerge.allowNoChecks is on in .foreman/config.json, so a PR with no checks merges once the reviewer approves it"] : [];
  return [ON, riskLine(maxRisk(repo)), ...noChecks, ...(merging.length ? ["Your never list mentions merging, and it still applies:", ...merging.map((r) => `  - ${r}`)] : [])];
}
