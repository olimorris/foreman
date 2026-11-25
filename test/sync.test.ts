import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, parentOf } from "../src/deliver.ts";
import { must } from "../src/exec.ts";
import type { Verdict } from "../src/rounds.ts";
import { spawn } from "../src/spawn.ts";
import { findTask, updateTask } from "../src/state.ts";
import { sync, type SyncProbes } from "../src/sync.ts";
import { fakeTerminal, tempRepo, writeRound } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");

const approve: Verdict = { verdict: "approve", summary: "Matches the intent.", issues: [], risk: "low", risk_note: "", decisions_touched: [] };

// T1 has an open PR, and T2 was spawned with T1's branch as its base, the way the spawn tool's base takes it.
function setup() {
  const repo = tempRepo();
  const term = fakeTerminal();
  const git = (cwd: string, ...args: string[]) => must(["git", "-C", cwd, ...args]).trim();
  const origin = mkdtempSync(join(tmpdir(), "foreman-origin-"));
  git(origin, "init", "-q", "--bare");
  git(repo.root, "remote", "add", "origin", origin);
  git(repo.root, "push", "-q", "origin", "main");
  git(repo.root, "fetch", "-q", "origin");
  const brief = (id: string) => {
    const file = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
    writeFileSync(file, `## Intent\n\nGreet in ${id}.\n\n## Spec\n\nWrite ${id}.txt.\n`);
    return file;
  };
  const commit = (id: string) => {
    const wt = findTask(repo, id).worktree;
    writeFileSync(join(wt, `${id}.txt`), "hi\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", `change ${id}`);
    return git(wt, "rev-parse", "HEAD");
  };
  spawn(repo, { id: "T1", brief: brief("T1"), owns: ["T1.txt"], base: "main", session: "s" }, term);
  const t1 = commit("T1");
  writeRound(repo, "T1", 1, { verdict: approve });
  updateTask(repo, "T1", { reviews: 1, status: "pr-open", pr: 7 });
  spawn(repo, { id: "T2", title: "feat: greet in T2", brief: brief("T2"), owns: ["T2.txt"], base: "foreman/T1", session: "s" }, term);
  commit("T2");
  writeRound(repo, "T2", 1, { verdict: approve });
  updateTask(repo, "T2", { reviews: 1, status: "done" });
  const squashMergeT1 = () => {
    git(repo.root, "merge", "-q", "--squash", "foreman/T1");
    git(repo.root, "commit", "-qm", "T1 (#7)");
    git(repo.root, "push", "-q", "origin", "main");
  };
  const probes: SyncProbes = { fetch: (base) => git(repo.root, "fetch", "-q", "origin", base), prState: (n) => (n === 7 ? "MERGED" : undefined), prBase: () => "main", setPrBase: () => true };
  const lastMessage = () => readFileSync(term.sent.at(-1)!.match(/read (\S+) and act/)![1]!, "utf8");
  return { repo, term, git, t1, squashMergeT1, probes, lastMessage };
}

describe("a task spawned on another task's branch", () => {
  test("builds on that task, with the base branch as its base", () => {
    const { repo, t1 } = setup();
    expect(findTask(repo, "T2")).toMatchObject({ base: "main", stackedOn: "T1", parentSha: t1, startSha: t1 });
    expect(readFileSync(join(repo.foreman, "tasks", "T2", "brief.md"), "utf8")).toContain("- Branch: foreman/T2 (from foreman/T1, which isn't merged yet)");
  });

  test("after a squash merge, is asked to replay only its own commits onto origin's base, naming the merged branch's last commit", () => {
    const { repo, term, t1, squashMergeT1, probes, lastMessage } = setup();
    squashMergeT1();
    expect(sync(repo, "main", term, probes)).toMatchObject({ merged: ["T1"], asked: ["T2"] });
    expect(lastMessage()).toContain(`run \`git rebase --onto origin/main ${t1}\` in your worktree`);
  });

  test("gets its PR against the base branch after one sync and its worker's rebase", () => {
    const { repo, term, git, t1, squashMergeT1, probes } = setup();
    squashMergeT1();
    sync(repo, "main", term, probes);
    expect(() => parentOf(repo, findTask(repo, "T2"))).toThrow("T2's branch still carries T1's commits");

    const wt = findTask(repo, "T2").worktree;
    git(wt, "rebase", "-q", "--onto", "origin/main", t1);
    expect(git(wt, "log", "--format=%s", "origin/main..HEAD")).toBe("change T2");
    const packet = readFileSync(deliver(repo, "T2", { dryRun: true }).packet, "utf8");
    expect(packet).not.toContain("This builds on");
    expect(findTask(repo, "T2").stackedOn).toBe("T1");

    expect(parentOf(repo, findTask(repo, "T2"))).toEqual({ movedOff: true });
    expect(findTask(repo, "T2").stackedOn).toBeUndefined();
  });
});
