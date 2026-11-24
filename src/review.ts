import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { indexPath, writeIndex } from "./decisions.ts";
import { appendEvent, lastDone } from "./events.ts";
import { must, run } from "./exec.ts";
import { pluginRoot, taskDir, worktreeDir, type Repo } from "./paths.ts";
import type { Rex } from "./rex.ts";
import { sendToTask } from "./send.ts";
import { capture, parseScreens, type Capture } from "./shots.ts";
import { tabLabel } from "./spawn.ts";
import { baseRef } from "./snapshot.ts";
import { findTask, updateTask, type Task } from "./state.ts";

export const MAX_REVISIONS = 2;

export type Issue = { where: string; screenshot?: string; intent: string; problem: string; expected: string };
export type Verdict = { verdict: "approve" | "changes"; summary: string; issues: Issue[]; risk: "low" | "medium" | "high"; risk_note: string; decisions_touched: string[] };

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

export const roundDir = (repo: Repo, id: string, round: number) => join(taskDir(repo, id), "review", `round-${round}`);

export function startReview(repo: Repo, id: string, rex: Rex, session = process.env.REX_SESSION): void {
  const task = findTask(repo, id);
  const target = session ?? task.rex?.session;
  if (!target) throw new Error("REX_SESSION isn't set and the task has no Rex tab");
  rex.open(target, tabLabel(task, "review "), task.worktree, [join(pluginRoot, "bin", "foreman"), "review-run", id], false);
}

export async function runReview(repo: Repo, id: string): Promise<string> {
  const task = findTask(repo, id);
  const round = (task.reviews ?? 0) + 1;
  updateTask(repo, id, { reviews: round });
  const dir = roundDir(repo, id, round);
  mkdirSync(dir, { recursive: true });
  try {
    const shots = await screenshots(repo, task, dir);
    // The user's local base branch lags behind merged PRs, which would put other tasks' work in this diff.
    const base = baseRef(repo, task.base);
    const diff = join(dir, "diff.patch");
    writeFileSync(diff, must(["git", "-C", task.worktree, "diff", `${base}...HEAD`]));
    const stat = must(["git", "-C", task.worktree, "diff", "--shortstat", `${base}...HEAD`]).trim();
    const dirty = must(["git", "-C", task.worktree, "status", "--porcelain"]).trim();
    const prompt = reviewPrompt({ task, round, diff, stat, dirty, shots, index: writeIndex(repo, task.base), previous: lastVerdict(repo, id, round), done: lastDone(repo, id), brief: join(taskDir(repo, id), "brief.md") });
    writeFileSync(join(dir, "prompt.md"), prompt);

    const r = run(
      // Not --agent: with it, --json-schema leaves structured_output empty.
      ["claude", "-p", "--output-format", "json", "--json-schema", JSON.stringify(VERDICT_SCHEMA),
        "--append-system-prompt-file", join(pluginRoot, "prompts", "reviewer.md"),
        "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--add-dir", taskDir(repo, id), join(repo.foreman, "decisions")],
      { cwd: task.worktree, stdin: prompt, env: { FOREMAN_ROLE: "reviewer" } },
    );
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

export function sendFeedback(repo: Repo, id: string, rex: Rex): string {
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
  sendToTask(repo, task, renderFeedback(verdict, round), rex);
  updateTask(repo, id, { revisions: revisions + 1, status: "running" });
  return `sent round ${round} feedback to ${id} (revision ${revisions + 1} of ${MAX_REVISIONS})`;
}

async function screenshots(repo: Repo, task: Task, dir: string): Promise<Capture & { before?: string; after?: string; note?: string }> {
  const cfg = loadConfig(repo).screenshots;
  const screens = parseScreens(readFileSync(join(taskDir(repo, task.id), "brief.md"), "utf8"));
  if (!screens.length) return { files: [], errors: [], note: "the brief names no screens" };
  if (!cfg) return { files: [], errors: [], note: "screenshots aren't configured for this repo" };

  const sha = must(["git", "-C", repo.root, "rev-parse", "--short=10", baseRef(repo, task.base)]).trim();
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
  task: Task; round: number; diff: string; stat: string; dirty: string; index: string; brief: string; previous?: string;
  shots: Capture & { before?: string; after?: string; note?: string };
};

function reviewPrompt(p: PromptInput): string {
  const shots = p.shots.before
    ? [`- Screenshots: before (${p.task.base}) in ${p.shots.before}, after (this branch) in ${p.shots.after}, one PNG per screen named in the brief.`,
       ...p.shots.errors.map((e) => `  - Capture problem: ${e}`)]
    : [`- Screenshots: none, because ${p.shots.note}.`];
  return [
    `Review task ${p.task.id}, round ${p.round}.`,
    "",
    `- Brief: ${p.brief}. Its Intent section is the acceptance criteria.`,
    `- Decisions index: ${p.index}. Open a record only when the diff touches it.`,
    `- Diff against ${p.task.base}: ${p.diff} (${p.stat || "no committed changes"}).`,
    `- Uncommitted changes in the worktree: ${p.dirty ? `\n${p.dirty}` : "none"}`,
    ...shots,
    ...(p.previous ? [`- Previous review: ${p.previous}. Check each of its issues was fixed.`] : []),
    ...handover(p.task.id, p.done),
    `- Owned paths: ${p.task.owns.join(", ")}`,
    "",
    "Return the verdict.",
  ].join("\n");
}
