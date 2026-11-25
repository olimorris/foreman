import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isInside, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { inFlight, loadTasks, type Task } from "./state.ts";
import { watcherArmed } from "./watch.ts";

export type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type LockContext =
  | { role: "orchestrator"; repo: Repo }
  | { role: "worker"; repo: Repo; task?: Task };

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export function areaLock(input: HookInput, ctx: LockContext): string | undefined {
  const tool = input.tool_name ?? "";
  const isBash = tool === "Bash";
  if (!isBash && !EDIT_TOOLS.includes(tool)) return undefined;
  const targets = writeTargets(input).map((p) => resolve(input.cwd, p));
  const { repo } = ctx;
  const worktrees = join(repo.foreman, "worktrees");

  if (ctx.role === "orchestrator") {
    if (isBash) return undefined;
    const bad = targets.find((p) => !isInside(p, repo.foreman) || isInside(p, worktrees));
    return bad && `The orchestrator never writes code (${bad}). Put the change in a brief and dispatch a worker.`;
  }

  const task = ctx.task;
  if (!task) return "This worker's FOREMAN_TASK isn't a known task. Stop and tell the user.";
  if (!isInside(input.cwd, task.worktree)) {
    return `This worker is running outside its worktree (${task.worktree}). Workers never work in the main checkout. Stop and tell the user.`;
  }
  for (const p of targets) {
    if (isInside(p, task.worktree)) {
      const rel = relative(task.worktree, p);
      if (!owned(rel, task.owns)) {
        return `${rel} is outside this task's owned paths (${task.owns.join(", ")}). Don't change it. If the task needs it, propose the change with: foreman propose "<decision>" --body "<why>" --paths <glob>`;
      }
    } else if (isInside(p, repo.foreman)) {
      return ".foreman/ holds Foreman's state. Use the foreman CLI instead of writing there.";
    } else if (isInside(p, repo.root)) {
      return `${p} is outside your worktree (${task.worktree}).`;
    } else if (!isBash) {
      return `${p} is outside your worktree (${task.worktree}).`;
    }
  }
  return undefined;
}

export function owned(rel: string, globs: string[]): boolean {
  return globs.some((g) => new Bun.Glob(g.endsWith("/") ? `${g}**` : g).match(rel));
}

function writeTargets(input: HookInput): string[] {
  const ti = input.tool_input ?? {};
  if (input.tool_name === "Bash") return bashWriteTargets(String(ti.command ?? ""));
  const path = ti.file_path ?? ti.notebook_path;
  return typeof path === "string" ? [path] : [];
}

// Best effort only: catches redirects and tee, not writes made by programs the command runs.
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];
  command = stripText(command);
  for (const m of command.matchAll(/(?:^|[^<>&\d])\d?>{1,2}\|?\s*("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g)) targets.push(m[1]!);
  for (const m of command.matchAll(/\btee\s+(?:-[a-zA-Z]+\s+)*("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g)) targets.push(m[1]!);
  return targets.map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => !t.startsWith("/dev/") && !t.startsWith("$"));
}

// A `>` inside a commit message or heredoc isn't a redirect, so blank out text that is only data.
function stripText(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, (_m, _q, _tag, rest) => `<<EOF${rest}`)
    .replace(/(>{1,2}\|?\s*|\btee\s+(?:-[a-zA-Z]+\s+)*)?("[^"]*"|'[^']*')/g, (m, op) => (op ? m : '""'));
}

// Claude Code overrides a Stop hook after repeated blocks, and an endless block loop burns turns, so give up after a few.
export const STOP_BLOCK_BUDGET = 3;

export type StopDecision = { block: boolean; blocks: number; reason?: string; warn?: string };

export function stopDecision(s: { inflight: number; armed: boolean; blocks: number }): StopDecision {
  if (s.inflight === 0 || s.armed) return { block: false, blocks: 0 };
  if (s.blocks < STOP_BLOCK_BUDGET) {
    return {
      block: true,
      blocks: s.blocks + 1,
      reason: `${s.inflight} task(s) in flight and the watcher isn't armed. Start \`foreman watch\` as a background command, then end your turn.`,
    };
  }
  return {
    block: false,
    blocks: 0,
    warn: `Foreman: stopping with ${s.inflight} task(s) in flight and no watcher. Nothing will wake the orchestrator until you message it.`,
  };
}

export function stopHook(repo: Repo): object {
  const inflight = inFlight(loadTasks(repo)).length;
  // The watcher started just before the stop may not have written its pid yet.
  let armed = watcherArmed(repo);
  if (!armed && inflight > 0) {
    Bun.sleepSync(1_500);
    armed = watcherArmed(repo);
  }
  const counter = join(repo.foreman, "stop-blocks");
  const blocks = existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0;
  const d = stopDecision({ inflight, armed, blocks });
  if (existsSync(repo.foreman)) writeFileSync(counter, String(d.blocks));
  if (d.block) return { decision: "block", reason: d.reason };
  return d.warn ? { systemMessage: d.warn } : {};
}

export function sessionStartContext(input: HookInput, ctx: LockContext, term: Terminal): string {
  if (ctx.role === "worker") {
    const task = ctx.task;
    if (!task) return "FOREMAN_TASK doesn't match a Foreman task. Do nothing and tell the user.";
    if (!isInside(realpathSync(input.cwd), task.worktree)) {
      return `STOP: this Foreman worker started outside its worktree (${task.worktree}). Do no work. Tell the user.`;
    }
    return `You are the Foreman worker for task ${task.id}. Your brief: ${join(ctx.repo.foreman, "tasks", task.id, "brief.md")}`;
  }
  const tasks = inFlight(loadTasks(ctx.repo));
  const armed = watcherArmed(ctx.repo);
  const lines = tasks.map((t) => {
    const tab = t.tab ? (term.alive(t.tab) ? "worker running" : "worker tab closed") : "no worker tab";
    const tree = existsSync(t.worktree) ? "" : ", worktree missing";
    return `- ${t.id}: ${t.status}, ${tab}${tree}, branch ${t.branch}`;
  });
  return [
    `Foreman state for ${ctx.repo.root}:`,
    ...(lines.length ? lines : ["- no tasks in flight"]),
    `Watcher: ${armed ? "armed" : "not armed"}.`,
    ...(tasks.length && !armed ? ["Run the recover skill, then start `foreman watch` in the background."] : []),
  ].join("\n");
}
