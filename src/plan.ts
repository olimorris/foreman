import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { overlaps } from "./decisions.ts";
import type { Repo } from "./paths.ts";
import { latest } from "./rounds.ts";
import { holdsSlot, isFinished, isMerged } from "./lifecycle.ts";
import { checkBrief, checkModel, CONVENTIONAL } from "./brief.ts";
import { loadTasks, type Task } from "./state.ts";
import { fileStore } from "./store.ts";
import { usageError } from "./help.ts";

export type PlanTask = { id: string; title: string; owns: string[]; deps: string[]; contract: boolean; model?: string; brief: string };
// startedAt is the first approval and stays when an edited plan is approved again, so the plan's budget keeps counting its own tasks.
export type Plan = { title: string; deadline?: string; approvedAt?: string; startedAt?: string; budgetResetAt?: string; calls?: string[]; cut?: string[]; maxWorkers?: number; automerge?: boolean; tasks: PlanTask[] };

const list = (v: string) => v.split(",").map((s) => s.trim().replace(/^`|`$/g, "")).filter((s) => s && !/^(none|-)$/i.test(s));

// The plan is one Markdown file the user reads and approves, so its task fields are plain "- Key: value" lines.
export function parsePlan(md: string): Plan {
  const [head = "", ...sections] = md.split(/^## /m);
  const title = head.match(/^# (?:Plan:\s*)?(.+)$/m)?.[1]?.trim() ?? "Plan";
  const deadline = head.match(/^Deadline:\s*(.+)$/im)?.[1]?.trim();
  const listAfter = (label: string) => head.match(new RegExp(`^${label}:\\s*\\n((?:\\s*-\\s+.+\\n?)+)`, "im"))?.[1]?.split("\n").map((l) => l.replace(/^\s*-\s+/, "").trim()).filter(Boolean) ?? [];
  const calls = listAfter("Calls");
  const cut = listAfter("Cut");
  const tasks = sections.map((section) => {
    const [first = "", ...rest] = section.split("\n");
    const m = first.match(/^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.+)$/);
    if (!m) throw new Error(`plan section "## ${first}" must be "## <id>: <title>"`);
    const body = rest.join("\n");
    const fieldsEnd = body.search(/^### /m);
    const fields = fieldsEnd < 0 ? body : body.slice(0, fieldsEnd);
    const field = (name: string) => fields.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.*)$`, "im"))?.[1] ?? "";
    const model = field("Model").trim().replace(/^`|`$/g, "");
    return {
      id: m[1]!,
      title: m[2]!.trim(),
      owns: list(field("Owns")),
      deps: list(field("Depends on")),
      contract: /^(yes|true)$/i.test(field("Contract").trim()),
      ...(model ? { model } : {}),
      brief: fieldsEnd < 0 ? "" : body.slice(fieldsEnd).replace(/^### /gm, "## ").trim() + "\n",
    };
  });
  return { title, ...(deadline ? { deadline } : {}), ...(calls.length ? { calls } : {}), ...(cut.length ? { cut } : {}), tasks };
}

export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`${t.id} appears twice`);
    ids.add(t.id);
    if (!t.owns.length) errors.push(`${t.id} owns no paths`);
    if (!CONVENTIONAL.test(t.title)) errors.push(`${t.id}'s title becomes its PR title, so it must be a conventional commit, like "feat: add tags to notes"`);
    try {
      checkBrief(t.brief);
    } catch (err) {
      errors.push(`${t.id}: ${(err as Error).message.replace("brief is", "its brief is")}`);
    }
    try {
      if (t.model) checkModel(t.model);
    } catch (err) {
      errors.push(`${t.id}: ${(err as Error).message}`);
    }
  }
  for (const t of plan.tasks) for (const d of t.deps) if (!ids.has(d)) errors.push(`${t.id} depends on ${d}, which isn't in the plan`);
  if (!errors.length) {
    try {
      waves(plan);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return errors;
}

// Dependencies only: tasks in one wave can still be serialised when their owned paths overlap.
export function waves(plan: Plan): string[][] {
  const left = new Map(plan.tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const out: string[][] = [];
  while (left.size) {
    const wave = [...left.values()].filter((t) => t.deps.every((d) => placed.has(d))).sort(byPriority(plan)).map((t) => t.id);
    if (!wave.length) throw new Error(`dependency cycle among ${[...left.keys()].join(", ")}`);
    for (const id of wave) placed.add(id), left.delete(id);
    out.push(wave);
  }
  return out;
}

const byPriority = (plan: Plan) => (a: PlanTask, b: PlanTask) =>
  Number(b.contract) - Number(a.contract) || plan.tasks.indexOf(a) - plan.tasks.indexOf(b);

export function sharedPaths(plan: Plan): string[] {
  const notes: string[] = [];
  const before = (a: string, b: string): boolean => {
    const t = plan.tasks.find((x) => x.id === b);
    return !!t && t.deps.some((d) => d === a || before(a, d));
  };
  plan.tasks.forEach((a, i) => plan.tasks.slice(i + 1).forEach((b) => {
    if (overlaps(a.owns, b.owns) && !before(a.id, b.id) && !before(b.id, a.id)) notes.push(`${a.id} and ${b.id} own overlapping paths, so they run one after the other`);
  }));
  return notes;
}


export type Waiting = { id: string; reason: string };
export type Starting = PlanTask & { stackedOn?: string };
export type CanStackOn = (dep: Task) => boolean;

// Nothing merges while the user sleeps, so a task whose last unmerged dependency is approved starts on that dependency's branch.
export function stackable(repo: Repo): CanStackOn | undefined {
  if (loadConfig(repo).stackTasks === false) return undefined;
  return (dep) => dep.status === "pr-open" && !dep.prClosed && !dep.mergedInto && latest(repo, dep)?.verdict?.verdict === "approve";
}

export function readyTasks(plan: Plan, tasks: Task[], max: number, canStackOn?: CanStackOn): { start: Starting[]; waiting: Waiting[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const busy = tasks.filter(holdsSlot);
  const start: Starting[] = [];
  const waiting: Waiting[] = [];
  for (const t of [...plan.tasks].sort(byPriority(plan))) {
    if (byId.has(t.id)) continue;
    const blockers = t.deps.filter((d) => !byId.get(d) || !isMerged(byId.get(d)!));
    // Only one level deep, because every rebase down a chain of unmerged branches can conflict.
    const parent = blockers.length === 1 && canStackOn ? byId.get(blockers[0]!) : undefined;
    const stackedOn = parent && !parent.stackedOn && canStackOn!(parent) ? parent.id : undefined;
    const clash = [...busy.map((b) => ({ id: b.id, owns: b.owns })), ...start].find((b) => overlaps(b.owns, t.owns));
    if (blockers.length && !stackedOn) waiting.push({ id: t.id, reason: parent && !parent.stackedOn ? `waits for ${parent.id}'s PR` : `waits for ${blockers.join(", ")} to merge` });
    else if (clash) waiting.push({ id: t.id, reason: `shares paths with ${clash.id}` });
    else if (busy.length + start.length >= max) waiting.push({ id: t.id, reason: `all ${max} worker slots are busy` });
    else start.push(stackedOn ? { ...t, stackedOn } : t);
  }
  return { start, waiting };
}

export const DEFAULT_WORKERS = 3;
export type WorkerLimit = { n: number; from: string };

export function workerLimit(repo: Repo, flag?: string): WorkerLimit {
  const sources: [unknown, string][] = [
    [flag, "--max"],
    [loadPlan(repo)?.maxWorkers, "this plan, set with foreman workers"],
    [loadConfig(repo).maxWorkers, "maxWorkers in .foreman/config.json"],
    [process.env.CLAUDE_PLUGIN_OPTION_MAXWORKERS, "the plugin's maxWorkers option"],
  ];
  const [value, from] = sources.find(([v]) => v !== undefined) ?? [DEFAULT_WORKERS, "Foreman's default"];
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? { n, from } : { n: DEFAULT_WORKERS, from: "Foreman's default" };
}

export const maxWorkers = (repo: Repo, flag?: string): number => workerLimit(repo, flag).n;

const atOnce = (n: number) => `${n} worker${n === 1 ? "" : "s"} at once`;

export function workers(repo: Repo, args: string[]): string[] {
  if (!args.length) {
    const { n, from } = workerLimit(repo);
    return [`${atOnce(n)}, from ${from}`];
  }
  const n = Number(args[0]);
  if (args.length > 1 || !/^\d+$/.test(args[0]!) || n <= 0) throw usageError("workers");
  // Stored on the plan, not in config.json, so the next plan goes back to the default.
  const plan = updatePlan(repo, (p) => {
    if (!p) throw new Error("no plan. This sets the limit for the current plan, and the orchestrator stores one with the plan tool");
    return { ...p, maxWorkers: n };
  });
  const tasks = loadTasks(repo);
  const holding = tasks.filter(holdsSlot).length;
  return [
    `${atOnce(n)} until this plan finishes`,
    ...(holding > n ? [`${holding} tasks already hold a slot. None of them stops, and new tasks wait until fewer than ${n} do`] : []),
    ...(holding < n && plan.approvedAt && readyTasks(plan, tasks, n, stackable(repo)).start.length ? ["waiting tasks start when the orchestrator next calls next"] : []),
  ];
}

export const planPath = (repo: Repo) => join(repo.foreman, "plan.json");

// plan.json holds the plan itself, so the store keeps it in a box that can start out empty.
const planStore = (repo: Repo) => fileStore<{ plan?: Plan }>(planPath(repo), {
  parse: (text) => ({ plan: JSON.parse(text) }),
  format: ({ plan }) => JSON.stringify(plan, null, 2) + "\n",
  empty: () => ({}),
});

export const loadPlan = (repo: Repo): Plan | undefined => planStore(repo).read().plan;

// Replaces the stored plan with what fn makes of it, under the plan's lock. fn gets undefined when no plan is stored.
export function updatePlan(repo: Repo, fn: (plan: Plan | undefined) => Plan): Plan {
  return planStore(repo).update((box) => (box.plan = fn(box.plan)));
}

const runningPlan = (repo: Repo, stored: Plan): boolean => {
  const tasks = loadTasks(repo);
  const done = (id: string) => tasks.some((t) => t.id === id && isFinished(t));
  return !stored.tasks.every((t) => done(t.id));
};

export function savePlan(repo: Repo, plan: Plan): void {
  mkdirSync(join(repo.foreman, "plan"), { recursive: true });
  for (const t of plan.tasks) writeFileSync(planBrief(repo, t.id), `# ${t.id}: ${t.title}\n\n${t.brief}`);
  // Re-storing an edited plan mid-run would otherwise switch automerge off and leave approved PRs unmerged.
  updatePlan(repo, (before) => (plan.automerge === undefined && before?.automerge && runningPlan(repo, before) ? { ...plan, automerge: true } : plan));
}

export const planBrief = (repo: Repo, id: string) => join(repo.foreman, "plan", `${id}.md`);

export function describePlan(plan: Plan, workerModel?: string): string {
  return [
    `${plan.title}${plan.deadline ? ` (deadline: ${plan.deadline})` : ""}, ${plan.tasks.length} task(s)`,
    ...waves(plan).map((w, i) => `wave ${i + 1}: ${w.map((id) => {
      const t = plan.tasks.find((x) => x.id === id)!;
      const model = t.model ?? workerModel;
      const notes = [...(t.contract ? ["contract"] : []), ...(model ? [model] : [])];
      return `${id}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    }).join(", ")}`),
    ...sharedPaths(plan),
    ...(plan.tasks.some((t) => !t.model) ? [`tasks with no Model line run on ${workerModel ? `${workerModel}, from workerModel in .foreman/config.json` : "Claude Code's default model"}`] : []),
  ].join("\n");
}
