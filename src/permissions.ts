import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { movedOnSince, tailLines, toolCalls, transcripts } from "./transcripts.ts";
import type { Repo } from "./paths.ts";
import { latest } from "./rounds.ts";
import { jsonStore } from "./store.ts";
import type { Task } from "./state.ts";

export type Role = "worker" | "reviewer" | "orchestrator";
export type Who = { role: Role; task?: string; worker?: string };

// prompt: the session waits at a permission prompt. auto-mode: auto mode's classifier refused the call. denied: refused because the session can't ask, as in claude -p.
export type BlockKind = "prompt" | "auto-mode" | "denied";

export type PermissionBlock = Who & {
  id: string;
  at: string;
  kind: BlockKind;
  tool: string;
  target: string;
  rule: string;
  reason?: string;
  transcript?: string;
  round?: number;
  closedAt?: string;
};

export type ToolCall = { tool: string; input: Record<string, unknown> };

const blocksStore = (repo: Repo) => jsonStore<{ blocks: PermissionBlock[] }>(join(repo.foreman, "blocks.json"), () => ({ blocks: [] }));

export function loadBlocks(repo: Repo): PermissionBlock[] {
  try {
    return blocksStore(repo).read().blocks ?? [];
  } catch {
    return [];
  }
}

export const openBlocks = (repo: Repo) => loadBlocks(repo).filter((b) => !b.closedAt);

function withBlocks<T>(repo: Repo, fn: (blocks: PermissionBlock[]) => T): T {
  return blocksStore(repo).update((saved) => fn((saved.blocks ??= [])));
}

// The hook and the transcript both see an auto mode refusal, so a block already known by its id isn't added twice.
export function recordBlocks(repo: Repo, found: PermissionBlock[]): PermissionBlock[] {
  if (!found.length) return [];
  return withBlocks(repo, (blocks) => {
    const added = found.filter((b) => !blocks.some((k) => k.id === b.id));
    blocks.push(...added);
    return added;
  });
}

export function closeBlocks(repo: Repo, which: (b: PermissionBlock) => boolean, at = new Date().toISOString()): PermissionBlock[] {
  if (!openBlocks(repo).some(which)) return [];
  return withBlocks(repo, (blocks) => {
    const closed = blocks.filter((b) => !b.closedAt && which(b));
    for (const b of closed) b.closedAt = at;
    return closed;
  });
}

export const unblock = (repo: Repo, task: string) => closeBlocks(repo, (b) => b.task === task);

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function targetOf({ tool, input }: ToolCall): string {
  if (tool === "Bash") return str(input.command).split("\n")[0]!.trim();
  if (tool === "WebFetch") return str(input.url);
  if (tool === "Grep" || tool === "Glob") return str(input.path) || str(input.pattern);
  return str(input.file_path) || str(input.notebook_path) || str(input.path);
}

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const READ_TOOLS = ["Read", "Grep", "Glob"];

// A rule for the exact command would only allow that one call again, so Bash gets the command's leading words and a wildcard.
export function ruleFor(call: ToolCall): string {
  const target = targetOf(call);
  if (call.tool === "Bash") {
    const prefix = commandPrefix(str(call.input.command));
    return prefix ? `Bash(${prefix} *)` : "Bash";
  }
  const folder = target.startsWith("/") ? `//${dirname(target).replace(/^\/+/, "")}/**` : "";
  if (EDIT_TOOLS.includes(call.tool)) return folder ? `Edit(${folder})` : "Edit";
  if (READ_TOOLS.includes(call.tool)) return folder ? `Read(${folder})` : "Read";
  if (call.tool === "WebFetch") {
    try {
      return `WebFetch(domain:${new URL(target).hostname})`;
    } catch {
      return "WebFetch";
    }
  }
  return call.tool;
}

const WORD = /^[A-Za-z][\w.:-]*$/;

export function commandPrefix(command: string): string {
  const parts = command.split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter(Boolean);
  const part = parts.find((p) => !/^cd(\s|$)/.test(p)) ?? "";
  const words = part.split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const prefix: string[] = [];
  for (const w of words) {
    if (!WORD.test(w) || prefix.length === 3) break;
    prefix.push(w);
  }
  return prefix.join(" ");
}

const clip = (s: string, width: number) => (s.length > width ? s.slice(0, width - 3) + "..." : s);

export function doing(b: Pick<PermissionBlock, "tool" | "target">, verb = true): string {
  const t = b.target ? `\`${clip(b.target, 80)}\`` : "";
  const [run, edit, read, search, fetch] = verb ? ["running", "editing", "reading", "searching", "fetching"] : ["run", "edit", "read", "search", "fetch"];
  if (!t) return `${verb ? "using" : "use"} ${b.tool}`;
  if (b.tool === "Bash") return `${run} ${t}`;
  if (EDIT_TOOLS.includes(b.tool)) return `${edit} ${t}`;
  if (b.tool === "Read") return `${read} ${t}`;
  if (READ_TOOLS.includes(b.tool)) return `${search} ${t}`;
  if (b.tool === "WebFetch") return `${fetch} ${t}`;
  return `${verb ? "using" : "use"} ${b.tool} on ${t}`;
}

export function whoOf(b: Who): string {
  if (b.role === "orchestrator") return "The orchestrator";
  if (b.role === "reviewer") return `${b.task}'s reviewer`;
  return b.worker ? `${b.worker} on ${b.task}` : `${b.task}'s worker`;
}

// The one line the orchestrator passes on to the user, naming the rule that would let the call through.
export function blockLine(b: PermissionBlock): string {
  const who = whoOf(b);
  const tab = b.role === "orchestrator" ? "this tab" : "that worker's tab";
  if (b.kind === "prompt") return `${who} is waiting at a permission prompt to ${doing(b, false)}. Answer it in ${tab}, or add \`${b.rule}\` in /permissions there so it stops asking.`;
  const by = b.kind === "auto-mode" ? " by auto mode" : b.role === "reviewer" ? ", since a review can't ask for permission" : "";
  const allow = b.role === "reviewer"
    ? `add \`${b.rule}\` to permissions.allow in ~/.claude/settings.json and run the review again`
    : `add \`${b.rule}\` in /permissions in ${tab}`;
  return `${who} was blocked from ${doing(b)}${by}. To allow it, ${allow}, or tell me to skip it.`;
}

// A shorter form for status and the pane, which already name the task. The pane is narrow, so it shows each part on its own line.
export function blockParts(b: PermissionBlock): string[] {
  if (b.kind === "prompt") return [`waiting at a permission prompt to ${doing(b, false)}`];
  return [`blocked from ${doing(b)}${b.kind === "auto-mode" ? " by auto mode" : ""}`, `allow it with ${b.rule}`];
}

export const blockSummary = (b: PermissionBlock) => blockParts(b).join(", ");

export type HookFields = {
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  reason?: string;
};

// claude -p fires PermissionRequest too, then refuses the call without asking, so a reviewer's request is never a prompt it waits at.
// The orchestrator tells the user about its own refusals, and no foreman unblock could close one, so only its prompts are kept.
export function hookBlock(event: string, input: HookFields, who: Who, at: string): PermissionBlock | undefined {
  const call = { tool: input.tool_name ?? "", input: input.tool_input ?? {} };
  if (!call.tool) return undefined;
  const base = { ...who, at, tool: call.tool, target: targetOf(call), rule: ruleFor(call), ...(input.transcript_path ? { transcript: input.transcript_path } : {}) };
  if (event === "permission-request" && who.role !== "reviewer") return { ...base, id: `prompt:${input.session_id ?? ""}:${at}`, kind: "prompt" };
  if (event === "permission-denied" && input.tool_use_id && who.role !== "orchestrator") return { ...base, id: input.tool_use_id, kind: "auto-mode", ...(input.reason ? { reason: input.reason } : {}) };
  return undefined;
}

const AUTO_MODE = "Permission for this action was denied by the Claude Code auto mode classifier";
const DENIED = "Permission for this action has been denied";

// The refusal comes back as the call's tool_result, so the call it answers gives the tool and command.
export function transcriptBlocks(lines: string[], who: Who, transcript?: string): PermissionBlock[] {
  return toolCalls(lines).flatMap((c): PermissionBlock[] => {
    const text = c.result?.error ? c.result.text : "";
    const kind: BlockKind | undefined = text.startsWith(AUTO_MODE) ? "auto-mode" : text.startsWith(DENIED) ? "denied" : undefined;
    if (!kind) return [];
    const reason = text.match(/Reason: \[?([^\].]+)/)?.[1];
    return [{ ...who, id: c.id, at: c.result!.at, kind, tool: c.tool, target: targetOf(c), rule: ruleFor(c), ...(reason ? { reason } : {}), ...(transcript ? { transcript } : {}) }];
  });
}

// claude -p lists each call it refused without asking in its result's permission_denials.
export function reviewerBlocks(stdout: string, who: Who, round: number, at: string): PermissionBlock[] {
  let denials: { tool_name?: string; tool_use_id?: string; tool_input?: Record<string, unknown> }[] = [];
  try {
    denials = JSON.parse(stdout).permission_denials ?? [];
  } catch {}
  return denials.flatMap((d) => {
    if (!d.tool_name || !d.tool_use_id) return [];
    const call = { tool: d.tool_name, input: d.tool_input ?? {} };
    return [{ ...who, id: d.tool_use_id, at, kind: "denied" as const, tool: call.tool, target: targetOf(call), rule: ruleFor(call), round }];
  });
}

// A session at a prompt writes nothing until the user answers, and the answer, yes or no, is the waiting call's tool_result.
export function settled(b: PermissionBlock, lines: string[]): boolean {
  const same = toolCalls(lines).filter((c) => c.tool === b.tool && targetOf(c) === b.target);
  if (b.kind === "prompt") {
    const waiting = same.filter((c) => c.at <= b.at).at(-1);
    if (waiting) return !!waiting.result;
    return movedOnSince(lines, b.at);
  }
  // A refused call that later runs is one the user allowed.
  return same.some((c) => c.at > b.at && c.result && !c.result.error);
}

const LIVE: Task["status"][] = ["running", "blocked", "needs-decision", "done", "limited", "exited"];

export type BlockSources = { transcript(task: Task): string | undefined; lines(file: string): string[]; reviewerOutput(task: Task): string | undefined };

export const fileSources = (repo: Repo): BlockSources => ({
  transcript: (task) => transcripts(repo, task).latest(),
  lines: (file) => (existsSync(file) ? tailLines(file) : []),
  reviewerOutput: (task) => latest(repo, task)?.output,
});

// Brings blocks.json up to date with what the sessions' transcripts and the latest review show, and returns the blocks still open.
export function syncBlocks(repo: Repo, tasks: Task[], src: BlockSources = fileSources(repo), now = new Date().toISOString()): PermissionBlock[] {
  const found: PermissionBlock[] = [];
  for (const task of tasks.filter((t) => t.status === "running")) {
    const file = src.transcript(task);
    if (file) found.push(...transcriptBlocks(src.lines(file), { role: "worker", task: task.id, ...(task.worker ? { worker: task.worker } : {}) }, file));
  }
  for (const task of tasks.filter((t) => t.reviews)) {
    const out = src.reviewerOutput(task);
    if (out) found.push(...reviewerBlocks(out, { role: "reviewer", task: task.id }, task.reviews!, now));
  }
  recordBlocks(repo, found);
  const lines = new Map<string, string[]>();
  const read = (file: string) => lines.get(file) ?? (lines.set(file, src.lines(file)), lines.get(file)!);
  closeBlocks(repo, (b) => {
    const task = tasks.find((t) => t.id === b.task);
    if (b.role !== "orchestrator" && (!task || !LIVE.includes(task.status))) return true;
    if (b.role === "reviewer") return b.round !== undefined && b.round < (task?.reviews ?? 0);
    return !!b.transcript && settled(b, read(b.transcript));
  }, now);
  return openBlocks(repo);
}
