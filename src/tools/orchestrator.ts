import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConvention, detectAdr } from "../adr.ts";
import { writeAdrs } from "../adrwrite.ts";
import { automerge } from "../automerge.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { budgetLeft, budgetOf, usd } from "../cost.ts";
import { accept, findContext, reject, writeIndex } from "../decisions.ts";
import { deliver } from "../deliver.ts";
import { logRun } from "../events.ts";
import { terminal } from "../integrations/index.ts";
import { findDecision, loadDecisions, propose } from "../ledger.ts";
import { activeLimit, limitLine } from "../limits.ts";
import { addNote, listNotes, loadNotes, newNoteMessage, removedNoteMessage, removeNote, shareNote, type Shared } from "../notes.ts";
import { defaultBase, taskDir, type Repo } from "../paths.ts";
import { blockSummary, unblock } from "../permissions.ts";
import { describePlan, loadPlan, maxWorkers, parsePlan, planBrief, readyTasks, savePlan, stackable, validatePlan, workers } from "../plan.ts";
import { names, tidy, unstoppableLine } from "../procs.ts";
import { answer, answerMs, ask } from "../questions.ts";
import { sendFeedback, startReview } from "../review.ts";
import { sendToTask } from "../send.ts";
import { capture, parseScreens } from "../shots.ts";
import { adrLayout, loadSkills } from "../skills.ts";
import { baseRef, snapshot } from "../snapshot.ts";
import { ensureForeman, spawn } from "../spawn.ts";
import { findTask, loadTasks, updateTask } from "../state.ts";
import { restartWorker, resume, stopWorker } from "../stop.ts";
import { sync } from "../sync.ts";
import { teardown } from "../teardown.ts";
import type { Terminal } from "../terminal.ts";
import { noInput, type Args, type Schema, type Tool } from "./tool.ts";

const str = (description: string) => ({ type: "string" as const, description });
const bool = (description: string) => ({ type: "boolean" as const, description });
const int = (description: string) => ({ type: "integer" as const, description });
const schema = (properties: Schema["properties"], required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}) });

const TASK = str("The task's id, such as T3");
const MODEL = str("Switch the worker to this model, such as sonnet or opus");
// The schema has no arrays yet, and globs and paths never hold spaces in practice.
const LIST = "Separate several with spaces";

const text = (args: Args, key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const list = (args: Args, key: string) => (text(args, key) ?? "").split(/\s+/).filter(Boolean);
const numbers = (args: Args, key: string) => list(args, key).map((n) => {
  if (!/^\d+$/.test(n)) throw new Error(`${key} takes ADR numbers, like "3 7", not "${n}"`);
  return Number(n);
});
const lines = (ls: string[]) => ls.join("\n");
const onModel = (task: { model?: string }) => (task.model ? `, on ${task.model}` : ", on Claude Code's default model");
const told = (s: Shared) => `Told: ${s.sent.join(", ") || "nobody"}${s.failed.length ? `. Couldn't reach: ${s.failed.join(", ")}` : ""}`;

// The server runs inside the orchestrator's own session, so a tab opens beside it only when the terminal can name that session.
function sessionOf(term: Terminal, tool: string): string {
  const session = term.currentSession();
  if (!session) throw new Error(`${tool} opens a tab, but this session isn't running inside ${term.name}`);
  return session;
}

function startingNothing(repo: Repo): void {
  const wait = activeLimit(repo);
  if (wait) throw new Error(`no new tasks start: ${limitLine(wait)}`);
  const room = budgetLeft(repo, loadTasks(repo));
  if (room.reason) throw new Error(`no new tasks start: ${room.reason}`);
}

const planFile = (repo: Repo) => join(repo.foreman, "plan.md");
const sectionsOf = (md: string) => md.split(/^(?=## )/m);
const sectionId = (section: string) => section.match(/^## ([A-Za-z0-9][A-Za-z0-9-]*):/)?.[1];

// Swaps in each changed task by its id and adds the new ones at the end, so the rest of plan.md stays as the user approved it.
function changeTasks(current: string, changed: string): string {
  const parts = sectionsOf(current);
  const head = sectionId(parts[0] ?? "") ? "" : parts.shift()!;
  for (const section of sectionsOf(changed)) {
    const id = sectionId(section);
    if (!id) {
      if (section.trim()) throw new Error("tasks takes only task sections, each starting with a line like ## T7: feat: add tags");
      continue;
    }
    const at = parts.findIndex((p) => sectionId(p) === id);
    if (at < 0) parts.push(section);
    else parts[at] = section;
  }
  return [head, ...parts].map((s) => s.trim()).filter(Boolean).join("\n\n") + "\n";
}

function planTool(repo: Repo, args: Args): string {
  if (args.approve) {
    const p = loadPlan(repo);
    if (!p) throw new Error("no plan to approve. Store one with the plan tool and its text first");
    const now = new Date().toISOString();
    savePlan(repo, { ...p, approvedAt: now, startedAt: p.startedAt ?? now });
    return `approved: ${p.title}. Call next to start the first tasks`;
  }
  const whole = text(args, "text");
  const changed = text(args, "tasks");
  if (whole && changed) throw new Error("give either text or tasks, not both");
  if (!whole && !changed) {
    const p = loadPlan(repo);
    if (!p) return "no plan";
    return describePlan(p, loadConfig(repo).workerModel) + (p.approvedAt ? `\napproved ${p.approvedAt}` : "\nnot approved yet");
  }
  const file = planFile(repo);
  let md = whole;
  if (changed) {
    if (!existsSync(file)) throw new Error("no plan to change. Give the whole plan as text first");
    md = changeTasks(readFileSync(file, "utf8"), changed);
  }
  ensureForeman(repo);
  writeFileSync(file, md!);
  const p = parsePlan(md!);
  const errors = validatePlan(p);
  if (errors.length) throw new Error(lines(errors.map((e) => `problem: ${e}`)));
  // A change keeps the run's worker limit, automerge and budget count, which a whole new plan starts without.
  const before = changed ? loadPlan(repo) : undefined;
  const kept = (["maxWorkers", "automerge", "startedAt", "budgetResetAt"] as const).filter((k) => before?.[k] !== undefined).map((k) => [k, before![k]]);
  savePlan(repo, { ...p, ...Object.fromEntries(kept) });
  return `${describePlan(p, loadConfig(repo).workerModel)}\nSaved as a draft in .foreman/plan.md. Show the user, and once they approve call plan with approve`;
}

function next(repo: Repo, args: Args, term: Terminal): string {
  const p = loadPlan(repo);
  if (!p?.approvedAt) throw new Error("no approved plan. Write one with the intake skill, then call plan with approve once the user agrees");
  startingNothing(repo);
  const session = sessionOf(term, "next");
  const max = maxWorkers(repo, args.max === undefined ? undefined : String(args.max));
  const { start, waiting } = readyTasks(p, loadTasks(repo), max, stackable(repo));
  const out: string[] = [];
  for (const t of start) {
    const task = spawn(repo, { id: t.id, title: t.title, model: t.model, brief: planBrief(repo, t.id), owns: t.owns, base: defaultBase(repo), session, stackedOn: t.stackedOn }, term);
    out.push(`spawned ${t.id}: ${t.title}${t.stackedOn ? ` (on top of ${t.stackedOn}'s branch, which isn't merged yet)` : ""}${onModel(task)}`);
  }
  for (const w of waiting) out.push(`waiting ${w.id}: ${w.reason}`);
  const left = p.tasks.filter((t) => !loadTasks(repo).some((x) => x.id === t.id)).length;
  if (!start.length && !left) out.push("every task in the plan has been started");
  return lines(out) || "nothing to start";
}

function spawnTool(repo: Repo, args: Args, term: Terminal): string {
  const id = args.task as string;
  // The id names the brief's folder, so one like ../x would write outside .foreman/tasks.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) throw new Error(`task id must be letters, digits and dashes: ${id}`);
  if (loadTasks(repo).some((t) => t.id === id)) throw new Error(`task ${id} already exists`);
  startingNothing(repo);
  const session = sessionOf(term, "spawn");
  ensureForeman(repo);
  mkdirSync(taskDir(repo, id), { recursive: true });
  const brief = join(taskDir(repo, id), "brief.in.md");
  writeFileSync(brief, args.brief as string);
  const task = spawn(repo, { id, title: text(args, "title"), model: text(args, "model"), brief, owns: list(args, "owns"), base: text(args, "base") ?? defaultBase(repo), session }, term);
  return `spawned ${task.id}: ${task.worktree} on ${task.branch}, ${term.name} tab ${task.tab?.window}${onModel(task)}`;
}

function setBudget(repo: Repo, args: Args): string {
  const amount = args.usd as number;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("usd must be a number of dollars above 0");
  const task = text(args, "task");
  if (task && args.plan) throw new Error("give either task or plan, not both");
  if (task) findTask(repo, task);
  const budget = { ...budgetOf(repo) };
  if (args.plan) budget.plan = amount;
  else if (task) budget.tasks = { ...budget.tasks, [task]: amount };
  else budget.perTask = amount;
  saveConfig(repo, { budget });
  return `budget: ${budget.perTask !== undefined ? `${usd(budget.perTask)} per task` : "no per-task limit"}, ${budget.plan !== undefined ? `${usd(budget.plan)} for the plan` : "no plan limit"}${Object.entries(budget.tasks ?? {}).map(([id, n]) => `, ${id} ${usd(n)}`).join("")}`;
}

function askTool(repo: Repo, args: Args): string {
  const decision = text(args, "decision");
  const proposer = decision ? findDecision(repo, decision).by : undefined;
  const task = text(args, "task") ?? (proposer !== "orchestrator" ? proposer : undefined);
  if (task) findTask(repo, task);
  const q = ask(repo, { question: args.question as string, call: args.call as string, ...(task ? { task } : {}), ...(decision ? { decision } : {}) });
  const minutes = answerMs(repo) / 60_000;
  return `recorded ${q.id}. Ask the user in your own words. ${minutes ? `If they don't answer within ${minutes} min, the watcher wakes you to go ahead with your call` : "answerMinutes is 0, so it waits for the user"}`;
}

function answerTool(repo: Repo, args: Args): string {
  const id = args.question as string;
  const given = text(args, "answer");
  if (!args.by_foreman && !given?.trim()) throw new Error("give the user's answer, or by_foreman when you went ahead without them");
  if (args.by_foreman && given) throw new Error("give either answer or by_foreman, not both");
  const q = answer(repo, id, args.by_foreman ? { byForeman: true } : { answer: given! });
  return q.by === "foreman" ? `recorded that Foreman went ahead with ${id}. It shows in the run summary so the user can check it` : `recorded the user's answer to ${id}`;
}

function noteTool(repo: Repo, args: Args, term: Terminal): string {
  ensureForeman(repo);
  if (args.remove !== undefined) {
    const note = removeNote(repo, args.remove as number);
    return `removed note ${args.remove}: ${note.text}. ${told(shareNote(repo, removedNoteMessage(note), "orchestrator", term))}`;
  }
  const fact = text(args, "text")?.trim();
  if (!fact) throw new Error("give the note's text, or remove with the number of a note to take out");
  const note = addNote(repo, fact, "orchestrator");
  if (!note) return "that note is already there";
  return `added note ${loadNotes(repo).length}. ${told(shareNote(repo, newNoteMessage(repo, note), "orchestrator", term))}`;
}

async function shots(repo: Repo, id: string): Promise<string> {
  const task = findTask(repo, id);
  const cfg = loadConfig(repo).screenshots;
  if (!cfg) throw new Error("no screenshots entry in .foreman/config.json; see the review skill");
  const screens = parseScreens(readFileSync(join(taskDir(repo, id), "brief.md"), "utf8"));
  if (!screens.length) throw new Error(`${id}'s brief has no ## Screens section`);
  const r = await capture(repo, cfg, task.worktree, id, screens, join(taskDir(repo, id), "shots-test"));
  const out = lines([...r.files.map((f) => `captured ${f}`), ...r.errors.map((e) => `problem: ${e}`)]);
  if (r.errors.length) throw new Error(out);
  return out;
}

function adr(repo: Repo, args: Args): string {
  const base = defaultBase(repo);
  switch (args.action) {
    case "detect": {
      const snap = snapshot(repo, baseRef(repo, base), ["docs", "doc", "adr", "decisions", ".adr-dir", "CONTEXT.md"]);
      const conv = detectAdr(snap);
      const context = findContext(snap);
      saveConfig(repo, { ...(conv ? { adr: conv } : {}), ...(context ? { context } : {}) });
      if (!conv) return `No ADR folder on ${base}. To start one, call adr with action init`;
      writeIndex(repo, base);
      return JSON.stringify({ base, ...conv, ...(context ? { context } : {}) }, null, 2);
    }
    case "init": {
      if (loadConfig(repo).adr) throw new Error("this repo already has an ADR convention; see .foreman/config.json");
      const layout = adrLayout(loadSkills(repo));
      const conv = defaultConvention(text(args, "dir"), layout);
      saveConfig(repo, { adr: conv });
      return `New decisions will go to ${conv.dir}, with its README, in the first decisions PR.${layout ? " They follow the layout in your adr skill." : ""}`;
    }
    case "write": {
      const dryRun = !!args.dry_run;
      const batch = writeAdrs(repo, { dryRun, push: !dryRun && args.push !== false, base });
      const out = batch.files.map((f) => (f.from && f.from !== f.file ? `move  ${f.from} -> ${f.file}` : `write ${f.file}`));
      if (dryRun) for (const f of batch.files.filter((x) => !x.from)) out.push(`\n--- ${f.file}\n${f.content}`);
      else out.push(batch.pr ? `opened PR #${batch.pr} from ${batch.branch}` : `committed on ${batch.branch}`);
      return lines(out);
    }
    case "index":
      return writeIndex(repo, base);
    default:
      throw new Error(`action must be detect, init, write or index, not ${args.action}`);
  }
}

// term is a thunk so a test can hand in a fake terminal, and the server picks the real one only when a tool needs it.
export function orchestratorTools(term: () => Terminal = terminal): Tool[] {
  const tool = (name: string, description: string, inputSchema: Schema, handler: (args: Args, repo: Repo) => string | Promise<string>): Tool => ({
    name,
    description,
    inputSchema,
    roles: ["orchestrator"],
    handler: (args, s) => handler(args, s.repo),
  });

  return [
    tool("plan", "Check and store a plan, change some of its tasks, show the stored plan, or approve it. Give text to save a whole plan to .foreman/plan.md, check it and store it as a draft. Give tasks to add or replace only those tasks in it, which also needs approving again. Give approve once the user agrees to the stored plan. Give none of them to show it. Load the intake skill when the user hands you a backlog.",
      schema({
        text: str("The whole plan in Markdown, as the intake skill lays it out"),
        tasks: str("Only the task sections that are new or changed, each starting with its ## line. A section whose id is already in the plan replaces that task, and the rest are added at the end"),
        approve: bool("Approve the stored plan"),
      }),
      (args, repo) => planTool(repo, args)),
    tool("next", "Start every planned task that's ready, contracts first, within the worker limit. A task whose only unmerged dependency has an approved, open PR starts on top of that dependency's branch. Otherwise tasks wait for their dependencies to merge, and for tasks that share their paths.",
      schema({ max: int("Start at most this many workers at once, this time only") }),
      (args, repo) => next(repo, args, term())),
    tool("spawn", "Start one task outside the plan: the worktree and branch foreman/<task>, then a worker tab started with the brief. Load the dispatch skill before writing a brief.",
      schema({
        task: TASK,
        title: str('The PR title, as a conventional commit, such as "feat: add an export button to settings"'),
        brief: str("The brief's full text, in Markdown, with its ## Intent and ## Spec sections"),
        owns: str(`The paths or globs the task owns, such as "src/settings/** docs/settings.md". ${LIST}`),
        base: str("The branch to start from, when it isn't the base branch"),
        model: str("The worker's model, such as sonnet, when it shouldn't run on the default"),
      }, ["task", "title", "brief", "owns"]),
      (args, repo) => spawnTool(repo, args, term())),
    tool("send", "Message a running worker. It arrives in that worker's session even when the worker is idle.",
      schema({ task: TASK, message: str("The message, as you'd say it to the worker") }, ["task", "message"]),
      (args, repo) => {
        const id = args.task as string;
        const task = findTask(repo, id);
        const via = sendToTask(repo, task, (args.message as string).trim(), term());
        // A blocked worker that gets an answer is working again.
        if (task.status === "blocked" || task.status === "needs-decision") updateTask(repo, id, { status: "running" });
        return `sent to ${id} via ${via}`;
      }),
    tool("review", "Review a task whose worker reported done. It opens a review tab, and the verdict arrives through the watcher. Load the review skill first.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => {
        startReview(repo, args.task as string, term());
        return `review of ${args.task} started in its own tab. The verdict arrives through the watcher.`;
      }),
    tool("feedback", "Send the reviewer's issues to the task's running worker after a changes verdict.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => sendFeedback(repo, args.task as string, term())),
    tool("deliver", "After an approve verdict, push the task's branch and open its PR with the review packet. Call it again after the worker rebases to update the PR.",
      schema({ task: TASK, title: str("Use this PR title instead of the task's"), dry_run: bool("Show the PR it would open without pushing") }, ["task"]),
      (args, repo) => deliver(repo, args.task as string, { dryRun: !!args.dry_run, title: text(args, "title") }).note),
    tool("sync", "Fetch the base branch, mark merged tasks and ask in-flight workers to rebase. A task built on another task's branch is asked to rebase when that branch gets new commits, and to move onto the base branch once it merges.",
      noInput,
      (_args, repo) => {
        const base = defaultBase(repo);
        const r = sync(repo, base, term());
        return lines([
          `${base} is at ${r.head.slice(0, 8)}`,
          ...(r.merged.length ? [`merged: ${r.merged.join(", ")}. Tear them down, then call next`] : []),
          ...r.mergedEarly.map((id) => `${id}'s PR merged into ${findTask(repo, id).mergedInto}, not ${base}. Keep ${id} until that branch merges`),
          ...(r.asked.length ? [`asked to rebase: ${r.asked.join(", ")}`] : []),
          ...r.retargeted.map((id) => `moved ${id}'s PR to ${base}`),
          ...(r.failed.length ? [`couldn't reach: ${r.failed.join(", ")}`] : []),
        ]);
      }),
    tool("teardown", "Close a task's tab and remove its worktree and branch once the work is merged. It refuses while the branch has unmerged work, unless discard is set, which needs the user's yes first.",
      schema({ task: TASK, discard: bool("Remove it even though its work isn't merged. Only after the user agrees") }, ["task"]),
      (args, repo) => {
        const r = teardown(repo, args.task as string, !!args.discard, term());
        if (!r.removed) throw new Error(r.message);
        return r.message;
      }),
    tool("pause", "Stop a task's worker by closing its tab. Its work so far stays in its worktree.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => {
        const id = args.task as string;
        const stopped = stopWorker(repo, findTask(repo, id), term());
        if (stopped) logRun(repo, id, "paused");
        return stopped ? `stopped ${id}'s worker. Its work so far is in its worktree` : `${id} had no worker running`;
      }),
    tool("resume", "Reopen a stopped worker's session in a new tab.",
      schema({ task: TASK, model: MODEL }, ["task"]),
      (args, repo) => {
        const id = args.task as string;
        const t = term();
        const task = resume(repo, id, t, sessionOf(t, "resume"), text(args, "model"));
        logRun(repo, id, "resumed");
        return `resumed ${id}'s worker in a new tab${onModel(task)}`;
      }),
    tool("restart", "Close a task's worker and reopen its session in a new tab, carrying on where it was.",
      schema({ task: TASK, model: MODEL }, ["task"]),
      (args, repo) => {
        const id = args.task as string;
        const t = term();
        const task = restartWorker(repo, findTask(repo, id), t, sessionOf(t, "restart"), text(args, "model"));
        logRun(repo, id, "restarted");
        return `restarted ${id}'s worker in a new tab, carrying on its last session${onModel(task)}`;
      }),
    tool("tidy", "Stop processes a task's old runs left behind, such as a test run that outlived its time limit. The watcher already does this on every pass, so call it only when a worker says a leftover process is in its way.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => {
        const id = args.task as string;
        const r = tidy(findTask(repo, id));
        const out = lines([
          ...(r.stopped.length ? [`stopped what ${id}'s old runs left behind: ${names(r.stopped)}`] : []),
          ...(r.failed.length ? [unstoppableLine(r.failed)] : []),
        ]);
        if (r.failed.length) throw new Error(out);
        return out || `${id} has no processes left over from old runs`;
      }),
    tool("unblock", "Close a task's permission blocks once the user has allowed the call or told you to skip it, so the task leaves Needs you.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => {
        const id = args.task as string;
        findTask(repo, id);
        const closed = unblock(repo, id);
        return closed.length ? lines(closed.map((b) => `closed: ${blockSummary(b)}`)) : `${id} has no open permission blocks`;
      }),
    tool("workers", "How many workers run at once and where that comes from, or change it for this plan. Raising it starts nothing, so call next after it. Lowering it stops no worker.",
      schema({ count: int("Run this many workers at once until the plan finishes") }),
      (args, repo) => {
        if (args.count !== undefined && (args.count as number) < 1) throw new Error("count must be 1 or more");
        return lines(workers(repo, args.count === undefined ? [] : [String(args.count)]));
      }),
    tool("automerge", "Whether Foreman merges approved PRs itself, or switch it for this plan. Turn it on only when the user says Foreman can merge PRs.",
      schema({ on: bool("true to turn it on, false to turn it off. Leave it out to see whether it's on") }),
      (args, repo) => lines(automerge(repo, args.on === undefined ? [] : [args.on ? "on" : "off"]))),
    tool("set_budget", "Set a spending limit in dollars: for every task, for one task, or for the whole plan. Raise a limit only when the user says so.",
      schema({ usd: { type: "number", description: "The limit in US dollars" }, task: str("Set the limit for this task only"), plan: bool("Set the limit for the whole plan") }, ["usd"]),
      (args, repo) => setBudget(repo, args)),
    tool("decisions", "List proposed decisions and accepted ones that aren't in the repo yet.",
      schema({ all: bool("List every decision, including rejected ones and ones already recorded as ADRs") }),
      (args, repo) => {
        const ds = loadDecisions(repo).filter((d) => args.all || d.status === "proposed" || (d.status === "accepted" && !d.adr));
        return ds.length ? lines(ds.map((d) => `${d.id.padEnd(6)} ${d.status.padEnd(9)} ${d.by.padEnd(12)} ${d.title}${d.decidedBy ? " (decided by Foreman)" : ""}`)) : "no open decisions";
      }),
    tool("accept", "Accept a proposed decision, rewritten to the repo's ADR rules. It messages the proposer and every in-flight worker whose owned paths overlap its paths. Load the decide skill first.",
      schema({
        decision: str("The decision's id, such as D-4"),
        title: str("The decision as a fact, and what it protects"),
        body: str("The record's body in Markdown, in the repo's ADR format, without the title line or status"),
        paths: str(`The paths or globs the decision covers, such as "src/export/**". ${LIST}`),
        supersedes: str(`The numbers of the ADRs it reverses. ${LIST}`),
        slug: str("The record's file name, when the default slug won't match the repo's style"),
      }, ["decision"]),
      (args, repo) => {
        const id = args.decision as string;
        const paths = text(args, "paths") === undefined ? undefined : list(args, "paths");
        const supersedes = text(args, "supersedes") === undefined ? undefined : numbers(args, "supersedes");
        const r = accept(repo, id, { title: text(args, "title"), body: text(args, "body"), paths, slug: text(args, "slug"), supersedes }, term());
        return `accepted ${id}. ${told(r)}`;
      }),
    tool("reject", "Reject a proposed decision, or overrule one Foreman accepted. It messages the proposer, and for an accepted one every worker the acceptance reached.",
      schema({ decision: str("The decision's id, such as D-4"), reason: str("Why, pointing at the record that settles it when there is one") }, ["decision", "reason"]),
      (args, repo) => {
        const r = reject(repo, args.decision as string, args.reason as string, term());
        return `rejected ${args.decision}. Told: ${r.sent.join(", ") || "nobody"}`;
      }),
    tool("propose", "Propose a decision for the user to settle, such as a draft decision from planning or a rule a PR comment states.",
      schema({
        title: str("The decision, stated as fact"),
        body: str("Why, and what was rejected, in Markdown"),
        paths: str(`The paths or globs it covers. ${LIST}`),
        supersedes: str(`The numbers of the ADRs it would reverse. ${LIST}`),
        slug: str("The record's file name, when the default slug won't match the repo's style"),
      }, ["title", "body"]),
      (args, repo) => {
        const d = propose(repo, { title: args.title as string, body: args.body as string, paths: list(args, "paths"), supersedes: numbers(args, "supersedes"), slug: text(args, "slug"), by: "orchestrator" });
        return `proposed ${d.id}`;
      }),
    tool("adr", "Look after the repo's ADR folder. detect reads the base branch's convention and saves it. init starts a new folder. write records accepted decisions on a docs-only branch and opens the decisions PR. index rewrites the decisions index. Load the decide skill first.",
      schema({
        action: str("detect, init, write or index"),
        dir: str("For init: the folder to start, when it isn't docs/decisions"),
        dry_run: bool("For write: list the files it would write, with their text, and change nothing"),
        push: bool("For write: false to commit without pushing or opening the PR"),
      }, ["action"]),
      (args, repo) => adr(repo, args)),
    tool("ask", "Record a question you're about to put to the user, with the call you'd make. Returns its id, such as Q-3. If the user doesn't answer within answerMinutes, the watcher wakes you to go ahead. Never record a question about money or lost work.",
      schema({
        question: str("The question, as you'll ask it"),
        call: str("What you'll do if the user doesn't answer"),
        task: str("The task the question holds up"),
        decision: str("The proposal the question is about, such as D-4"),
      }, ["question", "call"]),
      (args, repo) => askTool(repo, args)),
    tool("answer", "Record the user's answer to a question, even if you already went ahead, or record that you went ahead with your call.",
      schema({ question: str("The question's id, such as Q-3"), answer: str("The user's answer"), by_foreman: bool("You went ahead with your call without the user") }, ["question"]),
      (args, repo) => answerTool(repo, args)),
    tool("note", "Record a fact about the setup every worker should know, such as a test command that hangs or a test that already fails on the base branch, and send it to every running worker. Or remove a note that turned out wrong. Notes are facts, not decisions.",
      schema({ text: str("The fact"), remove: int("The number of a note to remove instead, as notes lists it") }),
      (args, repo) => noteTool(repo, args, term())),
    tool("notes", "List the notes about the setup.",
      noInput,
      (_args, repo) => {
        const notes = loadNotes(repo);
        return notes.length ? lines(listNotes(notes)) : "no notes yet. Add one with the note tool";
      }),
    tool("shots", "Screenshot a running task's screens, to check the screenshots entry in .foreman/config.json works.",
      schema({ task: TASK }, ["task"]),
      (args, repo) => shots(repo, args.task as string)),
  ];
}

export const ORCHESTRATOR_TOOLS = orchestratorTools();
