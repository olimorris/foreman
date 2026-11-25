import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { limitHit, type LimitHit } from "./limits.ts";
import type { Repo } from "./paths.ts";
import type { Task } from "./state.ts";

export type Usage = {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
export type Reply = { model: string; usage: Usage };
export type Activity = { what: string; since: number; idle: boolean };
export type ToolCall = { id: string; at: string; tool: string; input: Record<string, unknown>; result?: { error: boolean; text: string; at: string } };

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
// Claude Code names a project's folder after its path, with every character other than a letter, digit or dash turned into a dash.
export const transcriptDir = (cwd: string) => join(projectsDir(), cwd.replace(/[^A-Za-z0-9-]/g, "-"));

// Reviewers share the worker's folder and the user's own sessions share the repo's, so only recorded sessions count.
export const sessionsFile = (repo: Repo, taskId?: string) => (taskId ? join(repo.foreman, "tasks", taskId, "sessions") : join(repo.foreman, "orchestrator-sessions"));

export const loadSessions = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

export function recordSession(file: string, id: string): void {
  if (loadSessions(file).includes(id)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, id + "\n");
}

// A session's subagents write their own transcripts in a folder named after it.
function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? jsonlFiles(path) : f.endsWith(".jsonl") ? [path] : [];
  });
}

const TAIL_BYTES = 256 * 1024;

export function tailLines(file: string, bytes = TAIL_BYTES): string[] {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(size, bytes));
  try {
    readSync(fd, buf, 0, buf.length, size - buf.length);
  } finally {
    closeSync(fd);
  }
  // The first line of a tail usually starts mid-line.
  return buf.toString("utf8").split("\n").slice(size > buf.length ? 1 : 0);
}

// Read in chunks, because a transcript can run to hundreds of megabytes.
function eachLine(file: string, take: (line: string) => void, chunk: number): void {
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.alloc(chunk);
  const fd = openSync(file, "r");
  let rest = "";
  try {
    for (let n; (n = readSync(fd, buf, 0, chunk, null)) > 0; ) {
      const lines = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = lines.pop()!;
      lines.forEach(take);
    }
  } finally {
    closeSync(fd);
  }
  take(rest + decoder.end());
}

// Claude Code writes the line's own timestamp after its message, so the last one is the reply's even when a tool input carries its own.
// Only the model's own replies count, since a nudge queued into an idle session also writes to its transcript.
function replyAt(line: string): number | undefined {
  if (!line.includes('"type":"assistant"')) return undefined;
  const start = line.lastIndexOf('"timestamp":"');
  if (start < 0) return undefined;
  const at = Date.parse(line.slice(start + 13, line.indexOf('"', start + 13)));
  return Number.isNaN(at) ? undefined : at;
}

// Claude Code writes an API error as a synthetic assistant line, so the session is at its limit only while that line is its last reply.
function transcriptLimit(lines: string[]): LimitHit | undefined {
  type Line = { type?: string; timestamp?: string; isApiErrorMessage?: boolean; error?: string; message?: { content?: { type?: string; text?: string }[] | string } };
  for (const raw of [...lines].reverse()) {
    if (!raw.includes('"type":"assistant"')) continue;
    let line: Line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.type !== "assistant") continue;
    if (!line.isApiErrorMessage) return undefined;
    const content = line.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join(" ");
    const at = Date.parse(line.timestamp ?? "");
    if (Number.isNaN(at) || (line.error && line.error !== "rate_limit" && line.error !== "billing_error")) return undefined;
    return limitHit(text, at);
  }
  return undefined;
}

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Entry = { type?: string; timestamp?: string; message?: { content?: Block[] | string; stop_reason?: string } };

function entry(line: string): Entry | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : str(x?.text))).join(" ") : "");

// Each content block is its own line, and a tool call's result arrives as a later user line naming the call.
export function toolCalls(lines: string[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    const e = entry(line);
    if (!e) continue;
    const content = Array.isArray(e.message?.content) ? e.message!.content : [];
    const at = e.timestamp ?? "";
    for (const c of content) {
      if (e.type === "assistant" && c.type === "tool_use" && c.id) byId.set(c.id, { id: c.id, at, tool: c.name ?? "", input: c.input ?? {} });
      if (e.type === "user" && c.type === "tool_result" && c.tool_use_id) {
        const call = byId.get(c.tool_use_id);
        if (call) call.result = { error: !!c.is_error, text: textOf(c.content), at };
      }
    }
  }
  return [...byId.values()];
}

// A reply or a tool's result after the time means the session carried on, where a queued message alone doesn't.
export const movedOnSince = (lines: string[], at: string) =>
  lines.some((l) => (l.includes('"tool_result"') || l.includes('"type":"assistant"')) && (l.match(/"timestamp":"([^"]+)"/)?.[1] ?? "") > at);

// A tool call still waiting for its result is what the session is doing now.
function readActivity(lines: string[], cwd: string): Activity | undefined {
  const pending = new Map<string, Activity>();
  let last: Activity | undefined;
  for (const line of lines) {
    if (!line.includes('"type":"assistant"') && !line.includes('"tool_result"')) continue;
    const e = entry(line);
    if (!e) continue;
    const at = Date.parse(e.timestamp ?? "");
    const blocks = Array.isArray(e.message?.content) ? e.message!.content : [];
    if (Number.isNaN(at)) continue;
    if (e.type === "assistant") {
      for (const b of blocks) if (b.type === "tool_use" && b.id) pending.set(b.id, { what: describeTool(b, cwd), since: at, idle: false });
      last = e.message?.stop_reason === "end_turn" ? { what: "waiting", since: at, idle: true } : { what: "thinking", since: at, idle: false };
    } else if (e.type === "user") {
      for (const b of blocks) if (b.type === "tool_result" && b.tool_use_id) pending.delete(b.tool_use_id);
      last = { what: "thinking", since: at, idle: false };
    }
  }
  return [...pending.values()].at(-1) ?? last;
}

function describeTool(b: Block, cwd: string): string {
  const input = b.input ?? {};
  const path = (p: unknown) => (typeof p === "string" ? (p.startsWith(cwd) ? relative(cwd, p) : basename(p)) : "");
  switch (b.name) {
    case "Bash": {
      const first = String(input.command ?? "").split("\n")[0]!;
      // Workers often start a command by changing into their own worktree, which says nothing.
      return `$ ${first.replace(/^cd\s+\S+\s*(;|&&)\s*/, "")}`;
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `editing ${path(input.file_path)}`;
    case "Read":
      return `reading ${path(input.file_path)}`;
    case "Grep":
    case "Glob":
      return `searching for ${input.pattern ?? "files"}`;
    case "Agent":
    case "Task":
      return "running a subagent";
    case "TodoWrite":
      return "planning";
    default:
      return `using ${b.name}`;
  }
}

export type Transcripts = {
  files(): string[];
  latest(): string | undefined;
  replies(since?: number): Reply[];
  replyTimes(): number[];
  lastReply(): number | undefined;
  models(): string[];
  limit(): LimitHit | undefined;
  activity(): Activity | undefined;
  exists(session: string): boolean;
};

// No task means the orchestrator's sessions. Tests shrink the chunk to read across its boundaries.
export function transcripts(repo: Repo, task?: Pick<Task, "id" | "worktree">, { chunk = 1 << 20 } = {}): Transcripts {
  const cwd = task?.worktree ?? repo.root;
  const dir = transcriptDir(cwd);
  const files = () => {
    const sessions = loadSessions(sessionsFile(repo, task?.id));
    return jsonlFiles(dir).filter((f) => sessions.some((s) => f.includes(s)));
  };
  const latest = () => files().sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return {
    files,
    latest,
    // Claude Code writes one line per content block, each repeating the reply's usage, so replies are counted once by id.
    replies: (since) => {
      const byId = new Map<string, Reply>();
      for (const file of files()) {
        eachLine(file, (line) => {
          if (!line.includes('"usage"')) return;
          const e = entry(line) as (Entry & { message?: { id?: string; model?: string; usage?: Usage } }) | undefined;
          if (!e || (since !== undefined && !(Date.parse(e.timestamp ?? "") >= since))) return;
          const m = e.message;
          if (m?.id && m.usage && m.model) byId.set(m.id, { model: m.model, usage: m.usage });
        }, chunk);
      }
      return [...byId.values()];
    },
    replyTimes: () => files().flatMap((file) => {
      const times: number[] = [];
      eachLine(file, (line) => {
        const at = replyAt(line);
        if (at !== undefined) times.push(at);
      }, chunk);
      return times;
    }),
    lastReply: () => {
      const last = files().map((file) => tailLines(file, 2 * TAIL_BYTES).map(replyAt).filter((t) => t !== undefined).at(-1)).filter((t) => t !== undefined);
      return last.length ? Math.max(...last) : undefined;
    },
    models: () => {
      const ids = files().flatMap((f) => [...readFileSync(f, "utf8").matchAll(/"model":"(claude-[^"]+)"/g)].map((m) => m[1]!));
      return [...new Set(ids)];
    },
    limit: () => {
      const file = latest();
      return file ? transcriptLimit(tailLines(file, 64 * 1024)) : undefined;
    },
    activity: () => {
      const file = latest();
      return file ? readActivity(tailLines(file), cwd) : undefined;
    },
    exists: (session) => existsSync(join(dir, `${session}.jsonl`)),
  };
}
