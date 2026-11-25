import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Repo } from "../src/paths.ts";
import type { Task } from "../src/state.ts";
import { recordSession, sessionsFile, transcriptDir, transcripts } from "../src/transcripts.ts";
import { tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));

const at = (hhmm: string) => Date.parse(`2026-11-25T${hhmm}:00Z`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();
const line = (o: object) => JSON.stringify(o);
// Claude Code writes the timestamp after the message, which a tool's input can carry a timestamp of its own inside.
const assistant = (hhmm: string, content: object[] = [{ type: "text", text: "Done." }], stop: string | null = "end_turn", extra: object = {}) =>
  line({ type: "assistant", message: { content, stop_reason: stop }, ...extra, timestamp: iso(hhmm) });
const result = (hhmm: string, id: string) => line({ type: "user", timestamp: iso(hhmm), message: { content: [{ type: "tool_result", tool_use_id: id }] } });
const billed = (id: string, model = "claude-opus-5-5") => line({ type: "assistant", timestamp: iso("10:00"), message: { id, model, usage: { input_tokens: 1_000_000 } } });

function worker(): { repo: Repo; task: Task; write(file: string, lines: string[], mtime?: string): string } {
  const repo = tempRepo();
  const task: Task = { id: "T1", status: "running", branch: "foreman/T1", base: "main", worktree: join(repo.foreman, "worktrees", "T1"), owns: [], socket: "", createdAt: "" };
  recordSession(sessionsFile(repo, "T1"), "s-1");
  const write = (file: string, lines: string[], mtime?: string) => {
    const path = join(transcriptDir(task.worktree), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n");
    if (mtime) utimesSync(path, new Date(iso(mtime)), new Date(iso(mtime)));
    return path;
  };
  return { repo, task, write };
}

describe("a task's transcripts", () => {
  test("count each reply once, from its own sessions and their subagents only", () => {
    const { repo, task, write } = worker();
    write("s-1.jsonl", [billed("a"), billed("a"), billed("b"), billed("c", "claude-mystery-1")]);
    write("s-1/subagents/agent-1.jsonl", [billed("s", "claude-haiku-5-5")]);
    write("reviewer-9.jsonl", [billed("z")]);
    const replies = transcripts(repo, task).replies();
    expect(replies.map((r) => r.model).sort()).toEqual(["claude-haiku-5-5", "claude-mystery-1", "claude-opus-5-5", "claude-opus-5-5"]);
    expect(transcripts(repo, task).replies(at("11:00"))).toEqual([]);
  });

  test("name every model a session used, its subagents' too, so the PR and foreman cost agree", () => {
    const { repo, task, write } = worker();
    write("s-1.jsonl", [billed("a")]);
    write("s-1/subagents/agent-1.jsonl", [billed("s", "claude-haiku-5-5")]);
    write("reviewer-9.jsonl", [billed("z", "claude-sonnet-5-5")]);
    expect(transcripts(repo, task).models().sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
  });

  test("read reply times across chunk boundaries, from each line's own timestamp", () => {
    const { repo, task, write } = worker();
    const inTool = [{ type: "tool_use", id: "x", name: "Bash", input: { timestamp: "2020-01-01T00:00:00Z" } }];
    write("s-1.jsonl", [assistant("00:24", [{ type: "text", text: "café ☕ ".repeat(20) }]), result("00:25", "x"), assistant("07:17", inTool, "tool_use")]);
    expect(transcripts(repo, task, { chunk: 7 }).replyTimes()).toEqual([at("00:24"), at("07:17")]);
  });

  test("take the last reply from the model, not a message queued into an idle session", () => {
    const { repo, task, write } = worker();
    write("s-1.jsonl", [assistant("00:24"), line({ type: "system", timestamp: iso("01:19") }), line({ type: "queue-operation", timestamp: iso("07:17") })]);
    expect(transcripts(repo, task).lastReply()).toBe(at("00:24"));
    expect(transcripts(tempRepo(), task).lastReply()).toBeUndefined();
  });

  test("are at the usage limit only while Claude Code's limit error is the latest session's last reply", () => {
    const { repo, task, write } = worker();
    recordSession(sessionsFile(repo, "T1"), "s-2");
    const limit = (text: string, error = "rate_limit") => assistant("14:00", [{ type: "text", text }], null, { isApiErrorMessage: true, error });
    write("s-1.jsonl", [limit("You've hit your session limit · resets 3:45pm")], "14:00");
    write("s-2.jsonl", [assistant("13:50"), limit("You've hit your session limit · resets 3:45pm"), line({ type: "user", timestamp: iso("14:20"), message: { content: "[foreman] nudge" } })], "14:20");
    expect(transcripts(repo, task).limit()).toMatchObject({ at: at("14:00"), guessed: false });
    write("s-2.jsonl", [limit("You've hit your session limit · resets 3:45pm"), assistant("15:46")], "15:46");
    expect(transcripts(repo, task).limit()).toBeUndefined();
    write("s-2.jsonl", ["{not json", assistant("13:50"), limit("Login expired · Please run /login", "authentication_failed")], "15:47");
    expect(transcripts(repo, task).limit()).toBeUndefined();
  });

  test("show the tool call still waiting for its result as what the worker is doing", () => {
    const { repo, task, write } = worker();
    write("s-1.jsonl", [
      assistant("08:30", [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: join(task.worktree, "src/tags.ts") } }], "tool_use"),
      result("08:31", "a"),
      assistant("08:32", [{ type: "tool_use", id: "b", name: "Bash", input: { command: "cd /w/T1; timeout 900 swift test -j 1\necho done" } }], "tool_use"),
    ]);
    expect(transcripts(repo, task).activity()).toEqual({ what: "$ timeout 900 swift test -j 1", since: at("08:32"), idle: false });
  });

  test("show a worker that ended its turn as waiting, and one with a fresh tool result as thinking", () => {
    const { repo, task, write } = worker();
    const read = assistant("08:30", [{ type: "tool_use", id: "a", name: "Read", input: { file_path: join(task.worktree, "README.md") } }], "tool_use");
    write("s-1.jsonl", [read, result("08:31", "a"), assistant("08:33")]);
    expect(transcripts(repo, task).activity()).toEqual({ what: "waiting", since: at("08:33"), idle: true });
    write("s-1.jsonl", [read, result("08:31", "a")]);
    expect(transcripts(repo, task).activity()).toEqual({ what: "thinking", since: at("08:31"), idle: false });
    write("s-1.jsonl", [read]);
    expect(transcripts(repo, task).activity()?.what).toBe("reading README.md");
  });
});

test("the orchestrator's transcripts are the repo's recorded sessions", () => {
  const repo = tempRepo();
  recordSession(sessionsFile(repo), "orch");
  mkdirSync(transcriptDir(repo.root), { recursive: true });
  writeFileSync(join(transcriptDir(repo.root), "orch.jsonl"), billed("o") + "\n");
  writeFileSync(join(transcriptDir(repo.root), "users-own.jsonl"), billed("u") + "\n");
  expect(transcripts(repo).replies()).toHaveLength(1);
  expect(transcripts(repo).exists("orch")).toBe(true);
  expect(transcripts(repo).exists("gone")).toBe(false);
});
