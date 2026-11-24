import { describe, expect, test } from "bun:test";
import { areaLock, bashWriteTargets, owned, stopDecision, STOP_BLOCK_BUDGET, type LockContext } from "../src/hooks.ts";
import type { Task } from "../src/state.ts";

const repo = { root: "/r", foreman: "/r/.foreman" };
const task: Task = {
  id: "T1",
  status: "running",
  branch: "foreman/T1",
  base: "main",
  worktree: "/r/.foreman/worktrees/T1",
  owns: ["src/settings/", "docs/settings.md"],
  socket: "/s/T1.sock",
  createdAt: "",
};
const worker: LockContext = { role: "worker", repo, task };
const wt = task.worktree;
const edit = (file_path: string, cwd = wt) => ({ cwd, tool_name: "Edit", tool_input: { file_path } });
const bash = (command: string, cwd = wt) => ({ cwd, tool_name: "Bash", tool_input: { command } });

describe("areaLock for workers", () => {
  test("allows edits under owned paths, relative or absolute", () => {
    expect(areaLock(edit("src/settings/Pane.swift"), worker)).toBeUndefined();
    expect(areaLock(edit(`${wt}/docs/settings.md`), worker)).toBeUndefined();
  });

  test("denies edits in the worktree outside owned paths and points at propose", () => {
    expect(areaLock(edit("src/app/Main.swift"), worker)).toContain("foreman propose");
  });

  test("denies edits in the main checkout and in .foreman", () => {
    expect(areaLock(edit("/r/src/settings/Pane.swift"), worker)).toContain("outside your worktree");
    expect(areaLock(edit("/r/.foreman/tasks.json"), worker)).toContain(".foreman/");
    expect(areaLock(edit("/r/.foreman/worktrees/T2/src/settings/x"), worker)).toContain(".foreman/");
  });

  test("denies everything when the session runs outside its worktree", () => {
    expect(areaLock(edit("/r/src/settings/Pane.swift", "/r"), worker)).toContain("main checkout");
    expect(areaLock(bash("ls", "/r"), worker)).toContain("main checkout");
  });

  test("checks bash redirects but allows scratch files outside the repo", () => {
    expect(areaLock(bash("echo x > src/app/a.txt"), worker)).toContain("foreman propose");
    expect(areaLock(bash("make test > /private/tmp/log.txt 2>&1"), worker)).toBeUndefined();
    expect(areaLock(bash("swift test"), worker)).toBeUndefined();
  });

  test("covers MultiEdit and NotebookEdit and ignores read tools", () => {
    expect(areaLock({ cwd: wt, tool_name: "NotebookEdit", tool_input: { notebook_path: "nb.ipynb" } }, worker)).toBeDefined();
    expect(areaLock({ cwd: wt, tool_name: "MultiEdit", tool_input: { file_path: "src/x.ts" } }, worker)).toBeDefined();
    expect(areaLock({ cwd: wt, tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }, worker)).toBeUndefined();
  });

  test("denies a worker whose task isn't known", () => {
    expect(areaLock(edit("src/settings/a"), { role: "worker", repo })).toContain("isn't a known task");
  });
});

describe("areaLock for the orchestrator", () => {
  const orch: LockContext = { role: "orchestrator", repo };
  test("may write briefs in .foreman only", () => {
    expect(areaLock(edit("/r/.foreman/tasks/T1/brief.in.md", "/r"), orch)).toBeUndefined();
    expect(areaLock(edit("/r/src/a.ts", "/r"), orch)).toContain("never writes code");
    expect(areaLock(edit("/r/.foreman/worktrees/T1/src/a.ts", "/r"), orch)).toContain("never writes code");
    expect(areaLock(bash("git status", "/r"), orch)).toBeUndefined();
  });
});

test("bashWriteTargets finds redirects and tee, skipping fd dups and /dev", () => {
  expect(bashWriteTargets("a > out.txt && b >> 'log file' 2>&1")).toEqual(["out.txt", "log file"]);
  expect(bashWriteTargets("cmd | tee -a notes.md")).toEqual(["notes.md"]);
  expect(bashWriteTargets("cmd 2>/dev/null; x &>/dev/null")).toEqual([]);
  expect(bashWriteTargets("[ a -gt 1 ] && echo ok")).toEqual([]);
});

test("bashWriteTargets ignores > inside quoted text and heredoc bodies", () => {
  expect(bashWriteTargets(`git commit -m "Add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"`)).toEqual([]);
  expect(bashWriteTargets("echo 'a > b' > out.txt")).toEqual(["out.txt"]);
  expect(bashWriteTargets("git commit -F - <<'EOF'\nTitle\n\nBy: <a@b.c> and x > y\nEOF")).toEqual([]);
  expect(bashWriteTargets("cat <<EOF > notes.md\nline > other\nEOF")).toEqual(["notes.md"]);
});

test("owned treats a trailing slash as everything under it", () => {
  expect(owned("src/settings/deep/x.ts", ["src/settings/"])).toBe(true);
  expect(owned("src/settingsX/x.ts", ["src/settings/"])).toBe(false);
  expect(owned("a.md", ["*.md"])).toBe(true);
});

describe("stopDecision", () => {
  test("allows a stop with nothing in flight or the watcher armed", () => {
    expect(stopDecision({ inflight: 0, armed: false, blocks: 0 }).block).toBe(false);
    expect(stopDecision({ inflight: 2, armed: true, blocks: 2 })).toEqual({ block: false, blocks: 0 });
  });

  test("blocks until the budget runs out, then lets one stop through with a warning", () => {
    let blocks = 0;
    for (let i = 0; i < STOP_BLOCK_BUDGET; i++) {
      const d = stopDecision({ inflight: 1, armed: false, blocks });
      expect(d.block).toBe(true);
      blocks = d.blocks;
    }
    const last = stopDecision({ inflight: 1, armed: false, blocks });
    expect(last.block).toBe(false);
    expect(last.warn).toContain("no watcher");
    expect(last.blocks).toBe(0);
  });
});
