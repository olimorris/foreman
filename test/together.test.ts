import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.ts";
import { must, run } from "../src/exec.ts";
import { spawn } from "../src/spawn.ts";
import { findTask, loadTasks, updateTask } from "../src/state.ts";
import { gather, openPrs, renderSummary } from "../src/summary.ts";
import { loadPlan } from "../src/plan.ts";
import { mkdirSync } from "node:fs";
import { failureHint, outputPath, runTests, staleness, together, togetherDir, togetherLine, type Together } from "../src/together.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");

function withPrs(changes: Record<string, Record<string, string>>) {
  const repo = tempRepo();
  const term = fakeTerminal();
  writeFileSync(join(repo.root, "shared.txt"), "one\ntwo\nthree\n");
  must(["git", "-C", repo.root, "add", "."]);
  must(["git", "-C", repo.root, "commit", "-qm", "shared"]);
  for (const [id, files] of Object.entries(changes)) {
    const brief = join(repo.root, "..", `brief-${id}-${Date.now()}.md`);
    writeFileSync(brief, `## Intent\n\n${id}.\n\n## Spec\n\n${id}.\n`);
    const task = spawn(repo, { id, brief, owns: ["*"], base: "main", session: "s" }, term);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(task.worktree, file), text);
    must(["git", "-C", task.worktree, "add", "."]);
    must(["git", "-C", task.worktree, "commit", "-qm", `work ${id}`]);
    updateTask(repo, id, { status: "pr-open", pr: Number(id.slice(1)) });
  }
  return repo;
}

const worktrees = (root: string) => run(["git", "-C", root, "worktree", "list"]).stdout;

test("PRs that merge cleanly get the tests run on them together, and the worktree goes", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" } });
  saveConfig(repo, { test: "test -f a.txt && test -f b.txt && echo all good" });
  const r = await together(repo, "main", () => openPrs(repo));
  expect(r.line).toBe("together: 2 PRs merge cleanly and the tests pass");
  const saved = JSON.parse(readFileSync(join(repo.foreman, "together.json"), "utf8")) as Together;
  expect(saved.tested.map((t) => [t.pr, t.sha])).toEqual(["T1", "T2"].map((id) => [Number(id.slice(1)), must(["git", "-C", repo.root, "rev-parse", `foreman/${id}`]).trim()]));
  expect(readFileSync(outputPath(repo), "utf8")).toBe("all good\n");
  expect(existsSync(join(togetherDir(repo), "worktree"))).toBe(false);
  expect(worktrees(repo.root)).not.toContain("together");
});

test("a conflict names the earlier PR and its files, and the rest are still tested", async () => {
  const repo = withPrs({ T1: { "shared.txt": "uno\ntwo\nthree\n" }, T2: { "shared.txt": "eins\ntwo\nthree\n" }, T3: { "c.txt": "c\n" } });
  saveConfig(repo, { test: "true" });
  const r = await together(repo, "main", () => openPrs(repo));
  expect(r.line).toBe("together: #1 and #2 conflict in shared.txt; the tests pass with #1 and #3 merged");
  expect(r.result).toMatchObject({ merged: ["T1", "T3"], conflicts: [{ id: "T2", with: ["T1"], files: ["shared.txt"] }] });
});

test("failing tests name the PRs merged and the failing test, and keep the end of the output", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" }, T3: { "c.txt": "c\n" } });
  saveConfig(repo, { test: "seq 1 100; echo \"Test Case '-[App.LayerStripTests testReorder]' failed (0.01 seconds).\"; test ! -f a.txt" });
  const r = await together(repo, "main", () => openPrs(repo));
  expect(r.line).toBe("together: tests fail with #1, #2 and #3 merged: LayerStripTests.testReorder");
  const tail = readFileSync(outputPath(repo), "utf8").trimEnd().split("\n");
  expect(tail).toHaveLength(40);
  expect(tail[0]).toBe("62");
});

test("without a test command it still checks for conflicts", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" } });
  const r = await together(repo, "main", () => openPrs(repo));
  expect(r.line).toBe("together: 2 PRs merge cleanly, but the tests weren't run: there's no test command in .foreman/config.json");
});

test("fewer than two open PRs does nothing", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" } });
  updateTask(repo, "T1", { status: "running", pr: undefined });
  expect((await together(repo, "main", () => openPrs(repo))).line).toBe("together: no PRs are open, so there's nothing to test together");
  updateTask(repo, "T1", { status: "pr-open", pr: 1 });
  expect((await together(repo, "main", () => openPrs(repo))).line).toBe("together: only #1 is open, so there's nothing to test together");
  expect(existsSync(join(repo.foreman, "together.json"))).toBe(false);
});

test("a test run past its limit is stopped along with everything it started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-run-"));
  const marker = `foreman-hang-${Date.now()}`;
  const started = Date.now();
  const r = await runTests(`sh -c 'sleep 30; echo ${marker}' & sleep 30`, dir, 0.005);
  expect(r.status).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(run(["pgrep", "-f", marker]).stdout.trim()).toBe("");
});

test("the failing test's name comes from each runner's own output", () => {
  expect(failureHint("✘ Test \"Reorder layers\" recorded an issue at LayerStripTests.swift:12")).toBe("Reorder layers");
  expect(failureHint("--- FAIL: TestReorder (0.00s)")).toBe("TestReorder");
  expect(failureHint("FAILED tests/test_strip.py::test_reorder - assert 1 == 2")).toBe("tests/test_strip.py::test_reorder");
  expect(failureHint("(fail) strip > reorders [0.12ms]")).toBe("strip > reorders");
  expect(failureHint("compiling\nerror: cannot find 'Layer' in scope\nbuild stopped")).toBe("error: cannot find 'Layer' in scope");
  expect(failureHint("all fine")).toBeUndefined();
});

test("the summary says which PR to merge first, and when the check is out of date", async () => {
  const repo = withPrs({ T1: { "shared.txt": "uno\ntwo\nthree\n" }, T2: { "shared.txt": "eins\ntwo\nthree\n" } });
  await together(repo, "main", () => openPrs(repo));
  let md = renderSummary(gather(repo, loadPlan(repo)));
  expect(md).toContain("## Open PRs together\n\n- #2 conflicts with #1 in `shared.txt`. Merge #1 first, and Foreman then asks #2's worker to rebase.");
  expect(md).not.toContain("Out of date");

  const wt = findTask(repo, "T2").worktree;
  writeFileSync(join(wt, "more.txt"), "more\n");
  must(["git", "-C", wt, "add", "."]);
  must(["git", "-C", wt, "commit", "-qm", "more"]);
  md = renderSummary(gather(repo, loadPlan(repo)));
  expect(md).toContain("Out of date: #2's branch moved since this was checked. Run `foreman together` to check again.");
});

test("staleness lists moved, gone and new PRs", () => {
  const t: Together = { at: "", base: "main", baseSha: "b", merged: ["T1", "T2"], conflicts: [], tests: { status: "pass" },
    tested: [{ id: "T1", pr: 1, branch: "foreman/T1", sha: "a" }, { id: "T2", pr: 2, branch: "foreman/T2", sha: "b" }] };
  expect(staleness(t, [{ id: "T1", pr: 1, branch: "foreman/T1", sha: "a2" }, { id: "T3", pr: 3, branch: "foreman/T3", sha: "c" }]))
    .toEqual(["#1's branch moved", "#2 merged or closed", "#3 opened"]);
  expect(togetherLine({ ...t, tests: { status: "timeout", minutes: 15 } })).toBe("together: tests ran past 15 minutes with #1 and #2 merged, so Foreman stopped them");
});

test("a PR whose worker is busy again is still checked, and the summary doesn't call it closed", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" } });
  updateTask(repo, "T2", { status: "blocked" });
  expect(openPrs(repo).map((t) => t.id)).toEqual(["T1", "T2"]);
  expect((await together(repo, "main", () => openPrs(repo))).line).toStartWith("together: 2 PRs merge cleanly");
  updateTask(repo, "T1", { status: "running" });
  expect(renderSummary(gather(repo, loadPlan(repo)))).not.toContain("Out of date");
});

test("a call while a check runs makes it check again with the latest PRs before it exits", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" }, T3: { "c.txt": "c\n" } });
  updateTask(repo, "T3", { status: "running", pr: undefined });
  saveConfig(repo, { test: "true" });
  const seen: string[] = [];
  const runner = async (_cmd: string, cwd: string) => {
    seen.push(["a.txt", "b.txt", "c.txt"].filter((f) => existsSync(join(cwd, f))).join(","));
    if (seen.length === 1) {
      updateTask(repo, "T3", { status: "pr-open", pr: 3 });
      expect((await together(repo, "main", () => openPrs(repo), { runner })).line).toStartWith("together: already running");
    }
    return { status: "pass" as const, output: "" };
  };
  const r = await together(repo, "main", () => openPrs(repo), { runner });
  expect(seen).toEqual(["a.txt,b.txt", "a.txt,b.txt,c.txt"]);
  expect(r.line).toBe("together: 3 PRs merge cleanly and the tests pass");
  expect(existsSync(join(togetherDir(repo), "pid"))).toBe(false);
});

test("a lock left by a check that crashed doesn't stop the next one", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" } });
  mkdirSync(togetherDir(repo), { recursive: true });
  writeFileSync(join(togetherDir(repo), "pid"), "999999");
  expect((await together(repo, "main", () => openPrs(repo))).line).toStartWith("together: 2 PRs merge cleanly");
});

test("tests that fail on the base branch too aren't blamed on the PRs", async () => {
  const repo = withPrs({ T1: { "a.txt": "a\n" }, T2: { "b.txt": "b\n" } });
  saveConfig(repo, { test: "echo 'FAILED tests/test_strip.py::test_reorder'; exit 1" });
  const r = await together(repo, "main", () => openPrs(repo));
  expect(r.line).toBe("together: tests fail on main too: tests/test_strip.py::test_reorder");
  expect(renderSummary(gather(repo, loadPlan(repo)))).toContain("- The tests fail on main too: `tests/test_strip.py::test_reorder`, so they say nothing about these PRs.");
});
