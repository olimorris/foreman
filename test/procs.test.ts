import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.ts";
import { busy, commandName, cpuShare, cpuTime, leftovers, pidAlive, processesIn, tidy, unstoppableLine, type Proc } from "../src/procs.ts";

const worker = { socket: "/tmp/foreman-x/T1.sock" };
const proc = (pid: number, ppid: number, command: string, cpuMs = 0, ageMs = 0): Proc => ({ pid, ppid, cpuMs, ageMs, command });
const claude = proc(10, 5, "claude --agent foreman:worker --messaging-socket-path /tmp/foreman-x/T1.sock");

test("reads ps CPU times, whose minutes run past 60 on macOS", () => {
  expect(cpuTime("0:04.59")).toBe(4590);
  expect(cpuTime("296:01.75")).toBe(17_761_750);
  expect(cpuTime("1:02:03")).toBe(3_723_000);
  expect(cpuTime("2-00:00:01")).toBe(172_801_000);
  expect(cpuTime("05:23")).toBe(323_000);
});

test("a leftover is a process whose parent is gone, with everything it started", () => {
  const procs = [claude, proc(11, 10, "/bin/zsh -c eval 'swift test'"), proc(12, 11, "swift test"), proc(20, 1, "swift-test"), proc(21, 20, "xctest"), proc(30, 1, "claude --messaging-socket-path /tmp/foreman-x/T1.sock")];
  expect(leftovers(procs, worker).map((p) => p.pid)).toEqual([20, 21]);
});

test("a worker started under a leftover is never a leftover itself, nor is anything it runs", () => {
  const procs = [proc(20, 1, "zsh"), { ...claude, ppid: 20 }, proc(11, 10, "/bin/zsh -c eval 'swift test'"), proc(21, 20, "sleep 60")];
  expect(leftovers(procs, worker).map((p) => p.pid)).toEqual([20, 21]);
});

test("names the command the worker ran, not the shell Claude Code wraps it in", () => {
  const procs = [claude, proc(11, 10, "/bin/zsh -c eval 'timeout 900 swift test'"), proc(12, 11, "timeout 900 swift test -j 3"), proc(13, 12, "/usr/bin/swift-test -j 3"), proc(14, 10, "/usr/bin/sourcekit-lsp")];
  const none = { at: 0, cpu: {} };
  expect(commandName(procs, worker, none, false)).toBe("timeout 900 swift test -j 3");
  expect(commandName([claude, proc(14, 10, "/usr/bin/sourcekit-lsp")], worker, none, false)).toBeUndefined();
});

describe("with a dev server running beside a test", () => {
  const procs = (server: number, test: number) => [
    claude,
    proc(11, 10, "/bin/zsh -c eval 'npm run dev'"),
    proc(12, 11, "npm run dev", 0, 30 * 60_000),
    proc(13, 12, "node vite.js", server, 30 * 60_000),
    proc(21, 10, "/bin/zsh -c eval 'swift test'"),
    proc(22, 21, "swift test", 0, 25 * 60_000),
    proc(23, 22, "/usr/bin/swift-test", test, 25 * 60_000),
  ];
  const before = { at: 0, cpu: { "13": 1000, "23": 5000 } };

  test("an idle worker is waiting on the newest command that used no CPU", () => {
    expect(commandName(procs(1000, 5000), worker, before, false)).toBe("swift test");
    expect(commandName(procs(3000, 5000), worker, before, false)).toBe("swift test");
  });

  test("a busy worker is running the command that used the most CPU", () => {
    expect(commandName(procs(1500, 9000), worker, before, true)).toBe("swift test");
    expect(commandName(procs(9000, 5000), worker, before, true)).toBe("npm run dev");
  });
});

test("a serial make looks busy by the new compiler processes it starts, though ps counts no CPU for the ones that exited", () => {
  const make = (cc: number) => [claude, proc(11, 10, "/bin/zsh -c eval make"), proc(12, 11, "make", 50), proc(cc, 12, "cc -c foo.c", 20)];
  expect(busy({ at: 0, cpu: { "10": 0, "11": 0, "12": 50, "100": 20 } }, make(101), 30_000, worker)).toBe(true);
  expect(busy({ at: 0, cpu: { "10": 0, "11": 0, "12": 50, "101": 20 } }, make(101), 30_000, worker)).toBe(false);
  expect(busy({ at: 0, cpu: { "10": 0 } }, [claude, proc(30, 10, "caffeinate -i -t 300")], 30_000, worker)).toBe(false);
});

test("a process that outlives SIGKILL is reported as stuck, without advice that can't work", () => {
  const line = unstoppableLine([proc(4321, 1, "/usr/bin/xctest")]);
  expect(line).toBe("xctest (pid 4321) outlived SIGKILL, so it's stuck and usually only a restart of the Mac clears it");
});

test("CPU share is the CPU time used since the last sample over the time between them", () => {
  const before = { at: 0, cpu: { "12": 1000 } };
  expect(cpuShare(before, [proc(12, 11, "x", 4000), proc(13, 11, "y", 1000)], 20_000)).toBe(0.2);
  expect(cpuShare(before, [], 20_000)).toBe(0);
});

const spawned: number[] = [];
afterAll(() => spawned.forEach((p) => process.kill(p, "SIGKILL")));

test("tidy stops leftovers in a worktree, even one that ignores SIGTERM, and leaves the rest", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "foreman-procs-")));
  run(["sh", "-c", "sleep 300 >/dev/null 2>&1 & (trap '' TERM; sleep 301) >/dev/null 2>&1 & exit 0"], { cwd: dir });
  const kept = Bun.spawn(["sleep", "302"], { cwd: dir });
  spawned.push(kept.pid);
  expect(processesIn([dir])[0]!.map((p) => p.command)).toEqual(expect.arrayContaining(["sleep 300", "sleep 301", "sleep 302"]));
  const r = tidy({ socket: "", worktree: dir });
  expect(r.failed).toEqual([]);
  expect(r.stopped.map((p) => p.command).sort()).toEqual(expect.arrayContaining(["sleep 300", "sleep 301"]));
  expect(r.stopped.every((p) => !pidAlive(p.pid))).toBe(true);
  expect(pidAlive(kept.pid)).toBe(true);
}, 10_000);
