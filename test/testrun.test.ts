import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.ts";
import { runTests } from "../src/testrun.ts";

const dir = () => mkdtempSync(join(tmpdir(), "foreman-run-"));

test("a run past its limit is stopped along with everything it started", async () => {
  const marker = `foreman-hang-${Date.now()}`;
  const started = Date.now();
  const r = await runTests(`sh -c 'sleep 30; echo ${marker}' & echo started; sleep 30`, dir(), { minutes: 0.005 });
  expect(r).toMatchObject({ code: null, timedOut: true, output: "started\n" });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(run(["pgrep", "-f", marker]).stdout.trim()).toBe("");
});

test("a finished run gives its exit code, or the signal that killed it, and its output", async () => {
  expect(await runTests("echo hi; exit 3", dir(), { minutes: 1 })).toEqual({ code: 3, timedOut: false, output: "hi\n" });
  expect(await runTests("kill -SEGV $$", dir(), { minutes: 1 })).toMatchObject({ code: null, signal: "SIGSEGV", timedOut: false });
});

test("cancelling a run stops it and what it started", async () => {
  const marker = `foreman-cancel-${Date.now()}`;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  const started = Date.now();
  await runTests(`sh -c 'sleep 30; echo ${marker}' & sleep 30`, dir(), { minutes: 1, signal: stop.signal });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(run(["pgrep", "-f", marker]).stdout.trim()).toBe("");
});
