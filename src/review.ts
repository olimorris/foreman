import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, neverRules, telegramPlugins, withoutTelegram } from "./config.ts";
import { indexPath, writeIndex } from "./decisions.ts";
import { appendEvent, lastDone } from "./events.ts";
import { must, run, type Result, type RunOptions } from "./exec.ts";
import { limitLine, loadLimit, reviewerLimit, saveLimit, waitForReset, type Sleep } from "./limits.ts";
import { loadPlan } from "./plan.ts";
import { pluginRoot, taskDir, worktreeDir, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { capture, parseScreens, type Capture } from "./shots.ts";
import { checkModel, taskLabel } from "./spawn.ts";
import { diffBase, findTask, loadTasks, updateTask, type Task } from "./state.ts";
import { budgetLeft } from "./cost.ts";
import { loadSkills, prSkill, PR_SKILL, skillsDir, type Skill } from "./skills.ts";

export const MAX_REVISIONS = 2;

export type Issue = { where: string; screenshot?: string; intent: string; problem: string; expected: string };
export type PrDraft = { title: string; description: string };
export type Verdict = { verdict: "approve" | "changes"; summary: string; issues: Issue[]; risk: "low" | "medium" | "high"; risk_note: string; decisions_touched: string[]; pr?: PrDraft };

export const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "issues", "risk", "risk_note", "decisions_touched"],
  properties: {
    verdict: { enum: ["approve", "changes"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["where", "intent", "problem", "expected"],
        properties: {
          where: { type: "string" },
          screenshot: { type: "string" },
          intent: { type: "string" },
          problem: { type: "string" },
          expected: { type: "string" },
        },
      },
    },
    risk: { enum: ["low", "medium", "high"] },
    risk_note: { type: "string" },
    decisions_touched: { type: "array", items: { type: "string" } },
  },
};

export function verdictSchema(draftPr: boolean) {
  if (!draftPr) return VERDICT_SCHEMA;
  const pr = { type: "object", required: ["title", "description"], properties: { title: { type: "string" }, description: { type: "string" } } };
  return { ...VERDICT_SCHEMA, properties: { ...VERDICT_SCHEMA.properties, pr } };
}

export const roundDir = (repo: Repo, id: string, round: number) => join(taskDir(repo, id), "review", `round-${round}`);

export function startReview(repo: Repo, id: string, term: Terminal, session = term.currentSession()): void {
  const task = findTask(repo, id);
  reviewerModel(repo);
  const target = session ?? task.tab?.session;
  if (!target) throw new Error(`review opens a tab, but this session isn't running inside ${term.name} and ${id} has no tab to open it beside`);
  term.open(target, `review ${taskLabel(task)}`, task.worktree, [join(pluginRoot, "bin", "foreman"), "review-run", id], false);
}

export type ReviewDeps = { reviewer?: (cmd: string[], opts: RunOptions) => Result; sleep?: Sleep; now?: () => number; say?: (line: string) => void };

export async function runReview(repo: Repo, id: string, deps: ReviewDeps = {}): Promise<string> {
  const { reviewer = run, now = () => Date.now(), say = console.log } = deps;
  const hold = { sleep: deps.sleep, now, onWait: (l: Parameters<typeof limitLine>[0]) => say(`${limitLine(l, now())}, so the review of ${id} starts then`) };
  let model: string | undefined;
  try {
    model = reviewerModel(repo);
  } catch (err) {
    const line = `failed before round ${(findTask(repo, id).reviews ?? 0) + 1}: ${(err as Error).message}`;
    appendEvent(repo, id, "reviewed", line);
    return line;
  }
  await waitForReset(repo, hold);
  const task = findTask(repo, id);
  const round = (task.reviews ?? 0) + 1;
  updateTask(repo, id, { reviews: round });
  const dir = roundDir(repo, id, round);
  mkdirSync(dir, { recursive: true });
  try {
    const left = budgetLeft(repo, loadTasks(repo), id);
    if (left.reason) throw new Error(left.reason);
    const shots = await screenshots(repo, task, dir);
    // The user's local base branch lags behind merged PRs, which would put other tasks' work in this diff.
    const base = diffBase(repo, task);
    const diff = join(dir, "diff.patch");
    writeFileSync(diff, must(["git", "-C", task.worktree, "diff", `${base}...HEAD`]));
    const stat = must(["git", "-C", task.worktree, "diff", "--shortstat", `${base}...HEAD`]).trim();
    const dirty = must(["git", "-C", task.worktree, "status", "--porcelain"]).trim();
    const prompt = reviewPrompt({ task, against: against(task), round, diff, stat, dirty, shots, index: writeIndex(repo, task.base), previous: lastVerdict(repo, id, round), done: lastDone(repo, id), brief: join(taskDir(repo, id), "brief.md"), never: neverRules(loadConfig(repo)), automerge: loadPlan(repo)?.automerge === true, skills: loadSkills(repo) });
    writeFileSync(join(dir, "prompt.md"), prompt);

    let r = reviewer(reviewerCommand(repo, id, left.usd, model), { cwd: task.worktree, stdin: prompt, env: { FOREMAN_ROLE: "reviewer" } });
    // claude -p gives up at the usage limit instead of waiting, so the round waits for the reset and runs again.
    for (let hit = reviewerLimit(r.stdout, r.stderr, now()); hit; hit = reviewerLimit(r.stdout, r.stderr, now())) {
      if (!loadLimit(repo)) saveLimit(repo, { since: hit.at, resetsAt: hit.resetsAt, ...(hit.guessed ? { guessed: true } : {}), by: `${id}'s reviewer`, paused: [] });
      await waitForReset(repo, { ...hold, until: hit });
      const room = budgetLeft(repo, loadTasks(repo), id);
      if (room.reason) throw new Error(room.reason);
      r = reviewer(reviewerCommand(repo, id, room.usd, model), { cwd: task.worktree, stdin: prompt, env: { FOREMAN_ROLE: "reviewer" } });
    }
    writeFileSync(join(dir, "reviewer.json"), r.stdout || r.stderr);
    const verdict = parseVerdict(r.stdout);
    if (r.code !== 0 || !verdict) throw new Error(`the reviewer returned no verdict (exit ${r.code}); see ${join(dir, "reviewer.json")}`);
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
    writeFileSync(join(dir, "feedback.md"), renderFeedback(verdict, round));
    const line = verdictLine(verdict, round, task.revisions ?? 0);
    appendEvent(repo, id, "reviewed", line);
    return line;
  } catch (err) {
    const line = `failed in round ${round}: ${err instanceof Error ? err.message : err}`;
    appendEvent(repo, id, "reviewed", line);
    return line;
  }
}

// Every review with a bad model would fail, each one counted as a round, so the check runs before a round starts.
export function reviewerModel(repo: Repo): string | undefined {
  const model = loadConfig(repo).reviewerModel;
  try {
    if (model !== undefined) checkModel(model);
  } catch (err) {
    throw new Error(`reviewerModel in .foreman/config.json: ${(err as Error).message}`);
  }
  return model;
}

export function reviewerCommand(repo: Repo, id: string, budget?: number, model?: string, telegram = telegramPlugins()): string[] {
  const skills = loadSkills(repo);
  return [
    // Not --agent: with it, --json-schema leaves structured_output empty.
    "claude", "-p", "--output-format", "json", "--json-schema", JSON.stringify(verdictSchema(!!prSkill(skills))),
    ...(model ? ["--model", model] : []),
    ...(budget !== undefined ? ["--max-budget-usd", budget.toFixed(2)] : []),
    "--append-system-prompt-file", join(pluginRoot, "prompts", "reviewer.md"),
    "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--add-dir", taskDir(repo, id), join(repo.foreman, "decisions"),
    ...(skills.length ? [skillsDir(repo)] : []),
    ...(telegram.length ? ["--settings", JSON.stringify(withoutTelegram(telegram))] : []),
  ];
}

// A reply that ran out of turns can still carry its verdict as a JSON block in the text.
export function parseVerdict(stdout: string): Verdict | undefined {
  let out: { structured_output?: unknown; result?: string };
  try {
    out = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const candidates = [out.structured_output, ...[...String(out.result ?? "").matchAll(/```json\s*\n([\s\S]*?)\n```/g)].reverse().map((m) => m[1])];
  for (const c of candidates) {
    try {
      const v = typeof c === "string" ? JSON.parse(c) : c;
      if (v && (v.verdict === "approve" || v.verdict === "changes") && typeof v.summary === "string" && Array.isArray(v.issues)) {
        return { risk: "medium", risk_note: "", decisions_touched: [], ...v };
      }
    } catch {}
  }
  return undefined;
}

export function latestVerdict(repo: Repo, task: Task): Verdict | undefined {
  const file = join(roundDir(repo, task.id, task.reviews ?? 0), "verdict.json");
  return task.reviews && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

function lastVerdict(repo: Repo, id: string, before: number): string | undefined {
  for (let r = before - 1; r > 0; r--) {
    const file = join(roundDir(repo, id, r), "verdict.json");
    if (existsSync(file)) return file;
  }
  return undefined;
}

export function verdictLine(v: Verdict, round: number, revisions: number): string {
  if (v.verdict === "approve") return `approve, round ${round}, risk ${v.risk}: ${v.summary}`;
  const limit = revisions >= MAX_REVISIONS ? " - revision limit reached, escalate to the user" : "";
  return `changes, round ${round}, ${v.issues.length} issue(s)${limit}: ${v.summary}`;
}

export function renderFeedback(v: Verdict, round: number): string {
  return [
    `Review round ${round} found ${v.issues.length} thing(s) to fix against your brief's intent:`,
    "",
    ...v.issues.flatMap((i, n) => [
      `${n + 1}. ${i.where}${i.screenshot ? ` (screenshot: ${i.screenshot})` : ""}`,
      `   Intent: ${i.intent}`,
      `   Problem: ${i.problem}`,
      `   Expected: ${i.expected}`,
      "",
    ]),
    "Fix these within your owned paths, commit, then report done again.",
    "",
  ].join("\n");
}

export function sendFeedback(repo: Repo, id: string, term: Terminal): string {
  const task = findTask(repo, id);
  const round = task.reviews ?? 0;
  const file = join(roundDir(repo, id, round), "verdict.json");
  if (!round || !existsSync(file)) throw new Error(`${id} has no finished review`);
  const verdict = JSON.parse(readFileSync(file, "utf8")) as Verdict;
  if (verdict.verdict === "approve") throw new Error(`round ${round} approved ${id}, so there's no feedback to send`);
  const revisions = task.revisions ?? 0;
  if (revisions >= MAX_REVISIONS) {
    throw new Error(`${id} has had ${revisions} revision rounds. Escalate to the user with the screenshots in ${roundDir(repo, id, round)} instead`);
  }
  sendToTask(repo, task, renderFeedback(verdict, round), term);
  updateTask(repo, id, { revisions: revisions + 1, status: "running" });
  return `sent round ${round} feedback to ${id} (revision ${revisions + 1} of ${MAX_REVISIONS})`;
}

async function screenshots(repo: Repo, task: Task, dir: string): Promise<Capture & { before?: string; after?: string; note?: string }> {
  const cfg = loadConfig(repo).screenshots;
  const screens = parseScreens(readFileSync(join(taskDir(repo, task.id), "brief.md"), "utf8"));
  if (!screens.length) return { files: [], errors: [], note: "the brief names no screens" };
  if (!cfg) return { files: [], errors: [], note: "screenshots aren't configured for this repo" };

  const sha = must(["git", "-C", repo.root, "rev-parse", "--short=10", diffBase(repo, task)]).trim();
  const cache = join(repo.foreman, "cache", "shots", sha);
  const missing = screens.filter((s) => !existsSync(join(cache, `${s.name}.png`)));
  const errors: string[] = [];
  if (missing.length) {
    const wt = worktreeDir(repo, `base-${sha}`);
    if (!existsSync(wt)) must(["git", "-C", repo.root, "worktree", "add", "-q", "--detach", wt, sha]);
    try {
      errors.push(...(await capture(repo, cfg, wt, `base-${sha}`, missing, cache)).errors.map((e) => `before: ${e}`));
    } finally {
      run(["git", "-C", repo.root, "worktree", "remove", "--force", wt]);
    }
  }
  const before = join(dir, "before");
  mkdirSync(before, { recursive: true });
  for (const s of screens) if (existsSync(join(cache, `${s.name}.png`))) cpSync(join(cache, `${s.name}.png`), join(before, `${s.name}.png`));
  const after = join(dir, "after");
  const shot = await capture(repo, cfg, task.worktree, task.id, screens, after);
  return { files: shot.files, errors: [...errors, ...shot.errors.map((e) => `after: ${e}`)], before, after };
}

const handover = (id: string, done?: { test?: string[]; assumptions?: string[] }) => [
  `- How ${id}'s worker says the user should test it:`, ...(done?.test?.length ? done.test.map((s) => `  - ${s}`) : ["  - (no steps given)"]),
  `- Assumptions the worker made:`, ...(done?.assumptions?.length ? done.assumptions.map((s) => `  - ${s}`) : ["  - (none given)"]),
];

type PromptInput = {
  done?: { test?: string[]; assumptions?: string[] };
  task: Task; against: string; round: number; diff: string; stat: string; dirty: string; index: string; brief: string; previous?: string; never: string[]; automerge?: boolean; skills: Skill[];
  shots: Capture & { before?: string; after?: string; note?: string };
};

const against = (task: Task) => (task.stackedOn ? `${task.stackedOn}'s branch, which this task builds on` : task.base);

function reviewPrompt(p: PromptInput): string {
  const shots = p.shots.before
    ? [`- Screenshots: before (${p.against}) in ${p.shots.before}, after (this branch) in ${p.shots.after}, one PNG per screen named in the brief.`,
       ...p.shots.errors.map((e) => `  - Capture problem: ${e}`)]
    : [`- Screenshots: none, because ${p.shots.note}.`];
  return [
    `Review task ${p.task.id}, round ${p.round}.`,
    "",
    `- Brief: ${p.brief}. Its Intent section is the acceptance criteria.`,
    `- Decisions index: ${p.index}. Open a record only when the diff touches it.`,
    `- Diff against ${p.against}: ${p.diff} (${p.stat || "no committed changes"}).`,
    `- Uncommitted changes in the worktree: ${p.dirty ? `\n${p.dirty}` : "none"}`,
    ...shots,
    ...(p.previous ? [`- Previous review: ${p.previous}. Check each of its issues was fixed.`] : []),
    ...handover(p.task.id, p.done),
    `- Owned paths: ${p.task.owns.join(", ")}`,
    ...(p.never.length ? ["- This repo's never list. A change that breaks one of these is an issue:", ...p.never.map((r) => `  - ${r}`)] : []),
    ...(p.never.length && p.automerge ? ["- Automerge is on, so approving means Foreman merges this PR once its checks pass. A never rule about merging that this PR falls under is an issue."] : []),
    ...skillsSection(p.skills),
    "",
    "Return the verdict.",
  ].join("\n");
}

function skillsSection(skills: Skill[]): string[] {
  if (!skills.length) return [];
  const draft = prSkill(skills)
    ? [`When you approve, draft the PR's title and description in \`pr\`, following the ${PR_SKILL} skill. Start from the intent and the worker's test steps. Foreman adds the intent, assumptions, decisions, screenshots, your verdict and the risk below your description, so leave those out of it.`, ""]
    : [];
  return [
    "",
    "## The user's skills",
    "",
    "Check the change against each skill below whose description fits reviewing code. A change that breaks one is an issue, with the skill's name and the rule it breaks in `intent`.",
    "",
    ...draft,
    ...skills.flatMap((s) => [`### ${s.name}`, "", `${s.description || "(no description)"} From ${s.path}.`, "", s.body, ""]),
  ];
}
