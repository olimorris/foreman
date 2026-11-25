import { describe, expect, test } from "bun:test";
import {
  blockLine, commandPrefix, hookBlock, loadBlocks, openBlocks, recordBlocks, reviewerBlocks, ruleFor, settled, syncBlocks, transcriptBlocks, unblock,
  type BlockSources, type PermissionBlock,
} from "../src/permissions.ts";
import type { Task } from "../src/state.ts";
import { tempRepo } from "./helpers.ts";

const W2 = { role: "worker" as const, task: "T5", worker: "W2" };
const AT = "2026-11-25T10:00:00.000Z";

const use = (ts: string, id: string, name: string, input: object) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (ts: string, id: string, content: string, is_error = false) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
const AUTO = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Destructive or Unwanted Actions]. If you have other tasks that don't depend on this action, continue working on those.";

const block = (extra: Partial<PermissionBlock> = {}): PermissionBlock => ({
  ...W2, id: "toolu_1", at: AT, kind: "auto-mode", tool: "Bash", target: "gh pr merge 41", rule: "Bash(gh pr merge *)", ...extra,
});

test("the line for an auto mode refusal names the session, the command and the rule to add", () => {
  expect(blockLine(block())).toBe("W2 on T5 was blocked from running `gh pr merge 41` by auto mode. To allow it, add `Bash(gh pr merge *)` in /permissions in that worker's tab, or tell me to skip it.");
  expect(blockLine(block({ kind: "prompt" }))).toBe("W2 on T5 is waiting at a permission prompt to run `gh pr merge 41`. Answer it in that worker's tab, or add `Bash(gh pr merge *)` in /permissions there so it stops asking.");
  expect(blockLine(block({ role: "reviewer", worker: undefined, kind: "denied", tool: "Read", target: "/etc/hosts", rule: "Read(//etc/**)" })))
    .toBe("T5's reviewer was blocked from reading `/etc/hosts`, since a review can't ask for permission. To allow it, add `Read(//etc/**)` to permissions.allow in ~/.claude/settings.json and run the review again, or tell me to skip it.");
});

test("a Bash rule keeps the command's leading words and allows any arguments after them", () => {
  expect(commandPrefix("gh pr merge 41 --squash")).toBe("gh pr merge");
  expect(commandPrefix("cd /w/T5 && git push --force origin main")).toBe("git push");
  expect(commandPrefix("FOO=1 curl -sI https://example.com")).toBe("curl");
  expect(ruleFor({ tool: "Bash", input: { command: "./scripts/run.sh" } })).toBe("Bash");
  expect(ruleFor({ tool: "Write", input: { file_path: "/Users/me/notes/a.md" } })).toBe("Edit(//Users/me/notes/**)");
  expect(ruleFor({ tool: "WebFetch", input: { url: "https://docs.example.com/a" } })).toBe("WebFetch(domain:docs.example.com)");
  expect(ruleFor({ tool: "mcp__github__merge", input: {} })).toBe("mcp__github__merge");
});

describe("recording a block", () => {
  // As Claude Code 2.1.332 sent it to a PermissionRequest hook.
  const request = {
    session_id: "d2e7", transcript_path: "/t/d2e7.jsonl", hook_event_name: "PermissionRequest", tool_name: "Bash",
    tool_input: { command: "curl -sI https://example.com", description: "Fetch HTTP headers" },
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl -sI https://example.com" }], behavior: "allow", destination: "localSettings" }],
  };

  test("from the PermissionRequest hook, as a prompt the session waits at", () => {
    expect(hookBlock("permission-request", request, W2, AT)).toMatchObject({ kind: "prompt", tool: "Bash", target: "curl -sI https://example.com", rule: "Bash(curl *)", transcript: "/t/d2e7.jsonl", task: "T5", worker: "W2" });
  });

  test("never from a reviewer's PermissionRequest, since claude -p refuses the call without asking", () => {
    expect(hookBlock("permission-request", request, { role: "reviewer", task: "T5" }, AT)).toBeUndefined();
  });

  test("from the PermissionDenied hook, keyed by the call so the transcript doesn't add it again, and never the orchestrator's own", () => {
    const denied = { tool_name: "Bash", tool_input: { command: "gh pr merge 41" }, tool_use_id: "toolu_1", reason: "Destructive" };
    expect(hookBlock("permission-denied", denied, W2, AT)).toMatchObject({ id: "toolu_1", kind: "auto-mode", rule: "Bash(gh pr merge *)" });
    expect(hookBlock("permission-denied", denied, { role: "orchestrator" }, AT)).toBeUndefined();
    expect(hookBlock("permission-request", request, { role: "orchestrator" }, AT)).toMatchObject({ kind: "prompt", role: "orchestrator" });
  });

  test("from a transcript, where the refusal is the call's tool_result", () => {
    const lines = [
      use(AT, "toolu_1", "Bash", { command: "gh pr merge 41" }),
      result(AT, "toolu_1", AUTO, true),
      use(AT, "toolu_2", "Bash", { command: "ls" }),
      result(AT, "toolu_2", "Permission for this action is fine"),
    ];
    expect(transcriptBlocks(lines, W2, "/t/x.jsonl")).toEqual([block({ reason: "Destructive or Unwanted Actions", transcript: "/t/x.jsonl" })]);
  });

  test("from the reviewer's claude -p output", () => {
    const stdout = JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "curl -sI https://example.com" } }] });
    expect(reviewerBlocks(stdout, { role: "reviewer", task: "T5" }, 2, AT)).toEqual([
      { role: "reviewer", task: "T5", id: "toolu_9", at: AT, kind: "denied", tool: "Bash", target: "curl -sI https://example.com", rule: "Bash(curl *)", round: 2 },
    ]);
    expect(reviewerBlocks("not json", { role: "reviewer", task: "T5" }, 2, AT)).toEqual([]);
  });

  test("once, however many times it's seen, until foreman unblock closes it", () => {
    const repo = tempRepo();
    expect(recordBlocks(repo, [block()])).toHaveLength(1);
    expect(recordBlocks(repo, [block()])).toEqual([]);
    expect(unblock(repo, "T5")).toHaveLength(1);
    expect(openBlocks(repo)).toEqual([]);
    expect(loadBlocks(repo)[0]!.closedAt).toBeDefined();
  });
});

describe("a block settles", () => {
  const later = "2026-11-25T10:05:00.000Z";
  const waiting = [use("2026-11-25T09:59:59.000Z", "toolu_1", "Bash", { command: "gh pr merge 41" })];

  test("a prompt when the waiting call gets its result, whatever the user answered", () => {
    expect(settled(block({ kind: "prompt" }), waiting)).toBe(false);
    expect(settled(block({ kind: "prompt" }), [...waiting, result(later, "toolu_1", "The user doesn't want to proceed with this tool use.", true)])).toBe(true);
  });

  test("a refusal when the same call later runs", () => {
    const denied = [...waiting, result(AT, "toolu_1", AUTO, true)];
    expect(settled(block(), denied)).toBe(false);
    expect(settled(block(), [...denied, use(later, "toolu_3", "Bash", { command: "gh pr merge 41" }), result(later, "toolu_3", "merged")])).toBe(true);
  });
});

test("syncBlocks records what the transcripts and the latest review show, and closes blocks that settled", () => {
  const repo = tempRepo();
  const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, status: "running", branch: "", base: "main", worktree: `/w/${id}`, owns: [], socket: "", createdAt: "", ...extra });
  const files: Record<string, string[]> = {
    "/t/T5.jsonl": [use(AT, "toolu_1", "Bash", { command: "gh pr merge 41" }), result(AT, "toolu_1", AUTO, true)],
    "/t/T6.jsonl": [use(AT, "toolu_6", "Bash", { command: "gh pr merge 42" })],
  };
  const src: BlockSources = {
    transcript: (t) => `/t/${t.id}.jsonl`,
    lines: (f) => files[f] ?? [],
    reviewerOutput: (t) => (t.id === "T7" ? JSON.stringify({ permission_denials: [{ tool_name: "Read", tool_use_id: "toolu_7", tool_input: { file_path: "/etc/hosts" } }] }) : undefined),
  };
  recordBlocks(repo, [block({ id: "prompt:T6", task: "T6", worker: "W3", kind: "prompt", target: "gh pr merge 42", transcript: "/t/T6.jsonl" })]);
  const tasks = [task("T5", { worker: "W2" }), task("T6", { worker: "W3" }), task("T7", { status: "done", reviews: 1 })];
  expect(syncBlocks(repo, tasks, src, AT).map((b) => b.id)).toEqual(["prompt:T6", "toolu_1", "toolu_7"]);

  files["/t/T6.jsonl"]!.push(result("2026-11-25T10:01:00.000Z", "toolu_6", "merged"));
  const next = tasks.map((t) => (t.id === "T7" ? { ...t, status: "pr-open" as const } : t));
  expect(syncBlocks(repo, next, src, AT).map((b) => b.id)).toEqual(["toolu_1"]);
});
