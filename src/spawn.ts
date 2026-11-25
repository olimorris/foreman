import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./exec.ts";
import { baseRef } from "./snapshot.ts";
import { loadConfig } from "./config.ts";
import { findContext, writeIndex } from "./decisions.ts";
import { pluginArgs, socketPath, taskDir, worktreeDir, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { CONVENTIONAL } from "./plan.ts";
import { setTrust } from "./trust.ts";
import { loadTasks, withTasks, type Task } from "./state.ts";

export type SpawnOptions = { id: string; title?: string; brief: string; owns: string[]; base: string; session: string; claudeConfig?: string };

export function ensureForeman(repo: Repo): void {
  mkdirSync(join(repo.foreman, "tasks"), { recursive: true });
  const exclude = join(repo.root, ".git", "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(".foreman/")) {
    mkdirSync(join(repo.root, ".git", "info"), { recursive: true });
    appendFileSync(exclude, (current && !current.endsWith("\n") ? "\n" : "") + ".foreman/\n");
  }
}

export function checkBrief(text: string): void {
  for (const heading of ["## Intent", "## Spec"]) {
    if (!text.split("\n").some((l) => l.trim() === heading)) throw new Error(`brief is missing a "${heading}" section`);
  }
}

export function spawn(repo: Repo, opts: SpawnOptions, term: Terminal): Task {
  const { id, owns, base } = opts;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) throw new Error(`task id must be letters, digits and dashes: ${id}`);
  if (loadTasks(repo).some((t) => t.id === id)) throw new Error(`task ${id} already exists`);
  if (!owns.length) throw new Error("a task needs at least one --owns path");
  if (opts.title !== undefined && !CONVENTIONAL.test(opts.title)) throw new Error(`a task's title becomes its PR title, so it must be a conventional commit, like "feat: add tags to notes"`);
  const briefText = readFileSync(opts.brief, "utf8");
  checkBrief(briefText);

  ensureForeman(repo);
  const branch = `foreman/${id}`;
  const worktree = worktreeDir(repo, id);
  // Start from origin's copy when there is one, because the user's local branch lags behind merged PRs.
  const start = baseRef(repo, base);
  const startSha = must(["git", "-C", repo.root, "rev-parse", start]).trim();
  must(["git", "-C", repo.root, "worktree", "add", "--no-track", "-b", branch, worktree, startSha]);

  const dir = taskDir(repo, id);
  mkdirSync(dir, { recursive: true });
  const briefPath = join(dir, "brief.md");
  const index = writeIndex(repo, base);
  const context = loadConfig(repo).context ?? findContext(worktree);
  writeFileSync(briefPath, briefHeader({ id, worktree, branch, base, owns, index, context }) + briefText);
  setTrust(worktree, true, opts.claudeConfig);

  const task: Task = { id, ...(opts.title ? { title: opts.title } : {}), status: "running", branch, base, worktree, owns, socket: socketPath(repo, id), startSha, createdAt: new Date().toISOString() };
  withTasks(repo, (tasks) => tasks.push(task));
  task.tab = term.open(opts.session, tabLabel(task), worktree, workerCommand(task, term, `Your brief is ${briefPath}. Read it and start. This repo's Foreman workflow explicitly allows you to commit and rebase on ${branch}, so commit there as you go, and never on any other branch.`));
  withTasks(repo, (tasks) => Object.assign(tasks.find((t) => t.id === id)!, { tab: task.tab }));
  return task;
}

export function workerCommand(task: Task, term: Terminal, prompt: string, resume?: string): string[] {
  return [
    // Without the terminal's session ids, a user hook that names "your session" can't rename the orchestrator's session from a worker.
    "env", ...term.sessionEnv.flatMap((v) => ["-u", v]), "FOREMAN_ROLE=worker", `FOREMAN_TASK=${task.id}`,
    "claude", ...pluginArgs(),
    "--agent", "foreman:worker",
    "--permission-mode", "auto",
    // Auto mode's classifier weighs the user's global "never commit" rule, but this workflow allows commits on the task branch.
    // Allow rules only reach plain Bash calls: in code mode the classifier judges the whole script first.
    "--allowedTools", "Bash(git add *)", "Bash(git commit *)", "Bash(git rebase *)", "Bash(foreman *)",
    "--settings", JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" }, includeCoAuthoredBy: false }),
    "--messaging-socket-path", task.socket,
    "-n", `foreman ${task.id}`,
    ...(resume ? ["--resume", resume] : []),
    "--",
    prompt,
  ];
}

// Ids like T1 mean nothing to someone glancing across tabs, so the label carries the start of the task's title.
export function tabLabel(task: Pick<Task, "id" | "title">, prefix = ""): string {
  const summary = task.title && plainTitle(task.title).split(/\s+/).slice(0, 4).join(" ");
  return `${prefix}${task.id}${summary ? `: ${summary}` : ""}`;
}

export const plainTitle = (title: string) => title.replace(/^\w+(\([\w./-]+\))?!?:\s*/, "").trim();

type Header = { id: string; worktree: string; branch: string; base: string; owns: string[]; index: string; context?: string };

function briefHeader({ id, worktree, branch, base, owns, index, context }: Header): string {
  return [
    `# Task ${id}`,
    "",
    `- Worktree: ${worktree}`,
    `- Branch: ${branch} (from ${base})`,
    `- Owned paths: ${owns.map((o) => `\`${o}\``).join(", ")}`,
    `- Commits: this repo's Foreman workflow explicitly allows you to commit and rebase on ${branch}. Never commit on any other branch.`,
    `- Decisions: ${index} (one line each; open a full record only when your work touches it)`,
    ...(context ? [`- Domain terms: ${context}`] : []),
    '- Cross-cutting choices: `foreman propose "<decision>" --body "<why, and what was rejected>" --paths <glob>`',
    '- Report with: `foreman report done "<one line>" --test "<step>"... --assume "<assumption>"...`, or `foreman report blocked|needs-decision|rebased "<one line>"`',
    "",
    "",
  ].join("\n");
}
