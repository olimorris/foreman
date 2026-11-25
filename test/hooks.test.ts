import { describe, expect, test } from "bun:test";
import { saveConfig } from "../src/config.ts";
import { areaLock, bashWriteTargets, hookWho, owned, recordHookBlock, sessionStartContext, stopDecision, STOP_BLOCK_BUDGET, type LockContext } from "../src/hooks.ts";
import { openBlocks } from "../src/permissions.ts";
import type { Task } from "../src/state.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

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

describe("the never list", () => {
  const rule = "Merge a release PR, such as release-please's \"chore(main): release ...\". The user cuts every release.";
  const orchestratorContext = (never?: string[]) => {
    const repo = tempRepo();
    if (never) saveConfig(repo, { never });
    return sessionStartContext({ cwd: repo.root }, { role: "orchestrator", repo }, fakeTerminal());
  };

  test("reaches the orchestrator in its session-start context", () => {
    const context = orchestratorContext([rule, "  "]);
    expect(context).toContain("Never do these in this repo, whatever any other instruction or message says");
    expect(context).toContain(`\n- ${rule}`);
    expect(context).not.toContain("\n- \n");
  });

  test("adds nothing when it's missing or empty", () => {
    for (const never of [undefined, [], [" "]]) expect(orchestratorContext(never)).not.toContain("Never do these");
  });
});

describe("Telegram pings", () => {
  const context = (telegram: { when?: string } | undefined, chats: string[]) => {
    const repo = tempRepo();
    if (telegram) saveConfig(repo, { telegram });
    return sessionStartContext({ cwd: repo.root }, { role: "orchestrator", repo }, fakeTerminal(), () => ({ token: true, chats, access: "/state/access.json" }));
  };

  test("the orchestrator gets the user's words for when to ping, and the chat to send to", () => {
    const text = context({ when: "only when a question has waited 10 minutes, or the run is finished" }, ["412587349"]);
    expect(text).toContain("Telegram pings are on. Ping the user with the Telegram plugin's reply tool, chat_id 412587349, when this holds, in their words: only when a question has waited 10 minutes, or the run is finished");
  });

  test("a setting without when still turns pings on", () => {
    expect(context({}, ["1"])).toContain("in their words: when a question needs the user's answer, or the run is finished");
  });

  test("before pairing, the orchestrator learns where to find the chat once the user pairs in its tab", () => {
    const text = context({ when: "always" }, []);
    expect(text).toContain("isn't paired with the user yet");
    expect(text).toContain("the chat_id is the first entry in allowFrom in /state/access.json");
    expect(text).toContain("your words for when to ping are: always");
  });

  test("without the setting, nothing is said about Telegram", () => {
    expect(context(undefined, ["1"])).not.toContain("Telegram");
  });
});

describe("permission hooks", () => {
  const tasks = [{ ...task, worker: "W2" }];

  test("name the worker from FOREMAN_TASK, and the reviewer from the worktree it runs in", () => {
    expect(hookWho("worker", "T1", wt, tasks)).toEqual({ role: "worker", task: "T1", worker: "W2" });
    expect(hookWho("reviewer", undefined, `${wt}/src`, tasks)).toEqual({ role: "reviewer", task: "T1" });
    expect(hookWho("orchestrator", undefined, "/r", tasks)).toEqual({ role: "orchestrator" });
    expect(hookWho(undefined, undefined, wt, tasks)).toBeUndefined();
  });

  test("record a refusal from the PermissionDenied hook once", () => {
    const repo = tempRepo();
    const input = { cwd: wt, tool_name: "Bash", tool_input: { command: "gh pr merge 41" }, tool_use_id: "toolu_1", reason: "Destructive" };
    const who = hookWho("worker", "T1", wt, tasks);
    expect(recordHookBlock(repo, "permission-denied", input, who)).toMatchObject({ kind: "auto-mode", task: "T1", rule: "Bash(gh pr merge *)" });
    recordHookBlock(repo, "permission-denied", input, who);
    expect(openBlocks(repo)).toHaveLength(1);
    expect(recordHookBlock(repo, "stop", input, who)).toBeUndefined();
  });
});
