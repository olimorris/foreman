import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseline, baselineStatus, failingTests, failureNotes, type TestRun } from "../src/baseline.ts";
import { must, run } from "../src/exec.ts";
import { loadNotes } from "../src/notes.ts";
import { withTasks } from "../src/state.ts";
import type { Repo } from "../src/paths.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

describe("failing test names", () => {
  test.each([
    ["bun", "(pass) tags > adds one [0.20ms]\n(fail) tags > removes one [1.05ms]", ["tags > removes one"]],
    ["jest", "  ● Tags › removes one\n\n    expect(received).toBe(expected)", ["Tags › removes one"]],
    ["vitest", " FAIL  src/tags.test.ts > Tags > removes one", ["src/tags.test.ts > Tags > removes one"]],
    ["XCTest", "Test Case '-[AppTests.TagTests testRemove]' failed (0.012 seconds).", ["AppTests.TagTests.testRemove"]],
    ["Swift Testing", '✘ Test "Removes a tag" recorded an issue at TagTests.swift:12:5\n✘ Test "Removes a tag" failed after 0.01 seconds with 1 issue.', ["Removes a tag"]],
    ["pytest", "FAILED tests/test_tags.py::test_remove - AssertionError: 1 != 2", ["tests/test_tags.py::test_remove"]],
    ["go", "--- FAIL: TestRemove (0.00s)\n    --- FAIL: TestRemove/last (0.00s)", ["TestRemove", "TestRemove/last"]],
  ])("%s", (_runner, output, names) => {
    expect(failingTests(output)).toEqual(names);
  });

  test("gives up on output it doesn't know", () => {
    expect(failingTests("error: linker command failed with exit code 1")).toBeUndefined();
  });
});

describe("what a baseline notes", () => {
  const run = (code: number | null, failures?: string[]): TestRun => ({ code, timedOut: code === null, failures, tail: "/b/run.txt" });

  test("tests that fail every run, and tests that fail on only some", () => {
    expect(failureNotes("main", "bun test", [run(1, ["a", "b"]), run(1, ["a"])], "/b")).toEqual([
      "On main, this test fails on every run of `bun test`: `a`",
      "On main, this test is flaky, passing on some runs of `bun test` and failing on others: `b`",
    ]);
    expect(failureNotes("main", "bun test", [run(0), run(1, ["a", "b"])], "/b")[0]).toStartWith("On main, these tests are flaky");
  });

  test("an exit code or signal, and where the output is, when the names can't be read", () => {
    expect(failureNotes("main", "make check", [run(2), run(0)], "/b")).toEqual([
      "On main, `make check` failed with exit code 2 on some runs, and Foreman couldn't tell which tests failed. The last 40 lines of each run are in /b",
    ]);
    expect(failureNotes("main", "make check", [{ ...run(null), timedOut: false, signal: "SIGSEGV" }], "/b")[0]).toStartWith("On main, `make check` was killed by SIGSEGV on every run,");
  });

  test("nothing for clean runs or a run that hung", () => {
    expect(failureNotes("main", "bun test", [run(0), run(0)], "/b")).toEqual([]);
    expect(failureNotes("main", "bun test", [run(null), run(0)], "/b")).toEqual([]);
  });
});

describe("foreman baseline", () => {
  const options = (command: string, extra = {}) => ({ base: "main", command, minutes: 1, runs: 2, term: fakeTerminal(), ...extra });

  test("a clean pass adds no note but is recorded for status, and the worktree is gone", async () => {
    const repo = tempRepo();
    const r = await baseline(repo, options("test -f README.md"));
    expect(r.line).toBe("`test -f README.md` passed 2 of 2 runs on main");
    expect(loadNotes(repo)).toEqual([]);
    expect(baselineStatus(repo)).toMatch(/^baseline: `test -f README.md` passed 2 of 2 runs on main \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    expect(existsSync(join(repo.foreman, "baseline", "worktree"))).toBe(false);
    expect(must(["git", "-C", repo.root, "worktree", "list"]).trim().split("\n")).toHaveLength(1);
  }, 15_000);

  test("runs the base branch's committed code, not the main checkout's", async () => {
    const repo = tempRepo();
    must(["git", "-C", repo.root, "checkout", "-qb", "other"]);
    writeFileSync(join(repo.root, "local.txt"), "x\n");
    must(["git", "-C", repo.root, "add", "."]);
    must(["git", "-C", repo.root, "commit", "-qm", "local"]);
    const r = await baseline(repo, options("test ! -f local.txt", { runs: 1 }));
    expect(r.result.runs[0]!.code).toBe(0);
  }, 15_000);

  test("notes failing and flaky tests and sends them to running workers", async () => {
    const repo = tempRepo();
    const counter = join(repo.root, "..", `count-${Date.now()}`);
    writeFileSync(join(repo.root, "check.sh"), `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}\necho "(fail) tags > always"\n[ "$n" = 0 ] && echo "(fail) tags > sometimes"\nexit 1\n`);
    must(["git", "-C", repo.root, "add", "."]);
    must(["git", "-C", repo.root, "commit", "-qm", "check"]);
    withTasks(repo, (tasks) => tasks.push({ id: "T1", status: "running", owns: ["src/"], branch: "foreman/T1", base: "main", worktree: "/w/T1", socket: "/nonexistent.sock", tab: { session: "s", window: "w", pane: "b" }, createdAt: "" }));
    const term = fakeTerminal();
    const r = await baseline(repo, options("sh check.sh", { term }));
    expect(loadNotes(repo).map((n) => [n.by, n.text])).toEqual([
      ["baseline", "On main, this test fails on every run of `sh check.sh`: `tags > always`"],
      ["baseline", "On main, this test is flaky, passing on some runs of `sh check.sh` and failing on others: `tags > sometimes`"],
    ]);
    expect(r.line).toBe("`sh check.sh` passed 0 of 2 runs on main. Added 2 notes and sent them to T1. Read them with foreman notes");
    expect(term.sent).toHaveLength(2);
  }, 15_000);

  test("stops a hung run and everything it started, notes the hang once, and runs no more", async () => {
    const repo = tempRepo();
    const marker = `orphan-${Date.now()}`;
    const command = `(sleep 30; echo ${marker}) & echo waiting; sleep 30`;
    const started = Date.now();
    const r = await baseline(repo, options(command, { minutes: 0.02, runs: 2 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.result.runs).toEqual([expect.objectContaining({ code: null, timedOut: true })]);
    const dir = join(repo.foreman, "baseline");
    expect(loadNotes(repo).map((n) => n.text)).toEqual([`On main, \`${command}\` hung and was stopped after 0.02 minutes. Its last output is in ${dir}`]);
    expect(readFileSync(join(dir, "run-1.txt"), "utf8")).toBe("waiting\n");
    expect(run(["pgrep", "-f", marker]).stdout).toBe("");

    await baseline(repo, options(command, { minutes: 0.02, runs: 1 }));
    expect(loadNotes(repo)).toHaveLength(1);
  }, 15_000);

  test("names the signal that killed a run", async () => {
    const repo = tempRepo();
    const r = await baseline(repo, options("kill -SEGV $$", { runs: 1 }));
    expect(r.result.runs[0]).toMatchObject({ code: null, signal: "SIGSEGV", timedOut: false });
    expect(loadNotes(repo)[0]!.text).toStartWith("On main, `kill -SEGV $$` was killed by SIGSEGV on every run");
  }, 15_000);

  const inBackground = (repo: Repo, command: string) =>
    Bun.spawn(["bun", "-e", `
      const { baseline } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "baseline.ts"))});
      const { fakeTerminal } = await import(${JSON.stringify(join(import.meta.dir, "helpers.ts"))});
      await baseline(${JSON.stringify(repo)}, { base: "main", command: ${JSON.stringify(command)}, minutes: 1, runs: 1, term: fakeTerminal() });
    `], { stdout: "ignore", stderr: "ignore" });

  async function untilStarted(repo: Repo): Promise<void> {
    const log = join(repo.foreman, "baseline", "run-1.log");
    for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("waiting")); i++) await Bun.sleep(50);
  }

  test("a stopped baseline kills its test run and removes its worktree", async () => {
    const repo = tempRepo();
    const marker = `stopped-${Date.now()}`;
    const proc = inBackground(repo, `echo waiting; sleep 30; echo ${marker}`);
    await untilStarted(repo);
    expect(baselineStatus(repo)).toBe("baseline: running");
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(run(["pgrep", "-f", marker]).stdout).toBe("");
    expect(existsSync(join(repo.foreman, "baseline", "worktree"))).toBe(false);
    expect(existsSync(join(repo.foreman, "baseline", "pid"))).toBe(false);
    expect(baselineStatus(repo)).toBeUndefined();
  }, 15_000);

  test("status says a baseline that died stopped, even after an earlier one passed", async () => {
    const repo = tempRepo();
    await baseline(repo, options("true", { runs: 1 }));
    const marker = `killed-${Date.now()}`;
    const proc = inBackground(repo, `echo waiting; sleep 30; echo ${marker}`);
    await untilStarted(repo);
    proc.kill("SIGKILL");
    await proc.exited;
    run(["pkill", "-f", marker]);
    expect(baselineStatus(repo)).toBe("baseline: stopped before it finished");
  }, 15_000);

});
