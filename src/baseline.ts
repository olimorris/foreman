import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, run } from "./exec.ts";
import { addNote, newNoteMessage, shareNote } from "./notes.ts";
import type { Repo } from "./paths.ts";
import { notifyOrchestrator } from "./send.ts";
import { baseRef } from "./snapshot.ts";
import type { Terminal } from "./terminal.ts";
import { writeJson } from "./state.ts";
import { pidAlive } from "./procs.ts";
import { readPid } from "./watch.ts";

export const TEST_MINUTES = 15;
export const BASELINE_RUNS = 2;
const TAIL_LINES = 40;
const MAX_NAMES = 10;

export type TestRun = { code: number | null; signal?: string; timedOut: boolean; failures?: string[]; tail: string };
export type BaselineResult = { base: string; sha: string; command: string; startedAt: string; finishedAt: string; runs: TestRun[]; notes: string[] };
export type BaselineOptions = { base: string; command: string; minutes: number; runs: number; term: Terminal };

export const baselineDir = (repo: Repo) => join(repo.foreman, "baseline");
const resultFile = (repo: Repo) => join(baselineDir(repo), "result.json");
const pidFile = (repo: Repo) => join(baselineDir(repo), "pid");

// The runners workers meet most often. Any other runner's failure is noted by exit code, with a pointer to its output.
const RUNNERS: [RegExp, (name: string) => string][] = [
  [/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/, (n) => n], // bun test
  [/^● (.+)$/, (n) => n], // jest
  [/^FAIL\s+(\S.* > .+)$/, (n) => n], // vitest
  [/^Test Case '(?:-\[)?([^'\]]+)\]?' failed/, (n) => n.replace(" ", ".")], // XCTest
  [/^✘ Test (.+?) (?:failed|recorded an issue)/, (n) => n.replace(/^"(.*)"$/, "$1")], // Swift Testing
  [/^(?:FAILED|ERROR) (\S+::\S+)/, (n) => n], // pytest
  [/^--- FAIL: (\S+)/, (n) => n], // go test
];

export function failingTests(output: string): string[] | undefined {
  const names = new Set<string>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim())) {
    for (const [pattern, tidy] of RUNNERS) {
      const name = line.match(pattern)?.[1]?.trim();
      if (name && name !== "Test suite failed to run") names.add(tidy(name));
    }
  }
  return names.size ? [...names] : undefined;
}

const tests = (names: string[]) => {
  const shown = names.slice(0, MAX_NAMES).map((n) => `\`${n}\``).join(", ");
  return names.length > MAX_NAMES ? `${shown} and ${names.length - MAX_NAMES} more` : shown;
};

// Note text leaves out which run it was, so the next baseline finding the same problem doesn't add it again.
export const hangNote = (base: string, command: string, minutes: number, dir: string) =>
  `On ${base}, \`${command}\` hung and was stopped after ${minutes} minutes. Its last output is in ${dir}`;

const outcome = (r: TestRun) => (r.signal ? `was killed by ${r.signal}` : `failed with exit code ${r.code}`);

export function failureNotes(base: string, command: string, runs: TestRun[], dir: string): string[] {
  const finished = runs.filter((r) => !r.timedOut);
  const failed = finished.filter((r) => r.code !== 0);
  if (!failed.length) return [];
  const unparsed = failed.filter((r) => !r.failures);
  if (unparsed.length) {
    const how = [...new Set(unparsed.map(outcome))].join(" or ");
    const when = failed.length === finished.length ? "every run" : "some runs";
    return [`On ${base}, \`${command}\` ${how} on ${when}, and Foreman couldn't tell which tests failed. The last ${TAIL_LINES} lines of each run are in ${dir}`];
  }
  const counts = new Map<string, number>();
  for (const r of failed) for (const name of r.failures!) counts.set(name, (counts.get(name) ?? 0) + 1);
  const always = [...counts].filter(([, n]) => n === finished.length).map(([name]) => name);
  const flaky = [...counts].filter(([, n]) => n < finished.length).map(([name]) => name);
  return [
    ...(always.length ? [`On ${base}, ${always.length > 1 ? "these tests fail" : "this test fails"} on every run of \`${command}\`: ${tests(always)}`] : []),
    ...(flaky.length ? [`On ${base}, ${flaky.length > 1 ? "these tests are" : "this test is"} flaky, passing on some runs of \`${command}\` and failing on others: ${tests(flaky)}`] : []),
  ];
}

export async function runTests(command: string, cwd: string, ms: number, log: string, onStart?: (pid: number) => void): Promise<{ code: number | null; signal?: string; timedOut: boolean; output: string }> {
  const fd = openSync(log, "w");
  // Its own process group lets Foreman kill the builds and simulators a hung test run started, not just the shell that started them.
  const proc = Bun.spawn(["sh", "-c", command], { cwd, detached: true, stdin: "ignore", stdout: fd, stderr: fd });
  closeSync(fd);
  onStart?.(proc.pid);
  let timer: Timer | undefined;
  const timedOut = await Promise.race([proc.exited.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ms)))]);
  clearTimeout(timer);
  killGroup(proc.pid);
  await proc.exited;
  const signal = timedOut || proc.signalCode == null ? undefined : String(proc.signalCode);
  return { code: timedOut ? null : proc.exitCode, ...(signal ? { signal } : {}), timedOut, output: readFileSync(log, "utf8") };
}

const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

export async function baseline(repo: Repo, opts: BaselineOptions): Promise<{ result: BaselineResult; line: string }> {
  const dir = baselineDir(repo);
  mkdirSync(dir, { recursive: true });
  const other = readPid(pidFile(repo));
  if (other && other !== process.pid && pidAlive(other)) throw new Error(`a baseline run is already going (pid ${other})`);
  // A result left from an earlier plan would make status say this run passed before it has finished.
  for (const f of readdirSync(dir)) if (f === "result.json" || /^run-\d+\./.test(f)) rmSync(join(dir, f), { force: true });
  writeFileSync(pidFile(repo), String(process.pid));
  const worktree = join(dir, "worktree");
  let group: number | undefined;
  const cleanUp = () => {
    if (group) killGroup(group);
    removeWorktree(repo, worktree);
    rmSync(pidFile(repo), { force: true });
  };
  // Closing the orchestrator or stopping its background task signals this process, and without this the hung test it started would run on for hours.
  const onSignal = (signal: keyof typeof SIGNALS) => (cleanUp(), process.exit(SIGNALS[signal]));
  for (const s of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) process.on(s, onSignal);

  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const told = new Set<string>();
  const note = (text: string) => {
    const added = addNote(repo, text, "baseline");
    if (!added) return;
    notes.push(text);
    for (const id of shareNote(repo, newNoteMessage(repo, added), "baseline", opts.term).sent) told.add(id);
  };

  const runs: TestRun[] = [];
  let result: BaselineResult;
  try {
    const sha = must(["git", "-C", repo.root, "rev-parse", baseRef(repo, opts.base)]).trim();
    removeWorktree(repo, worktree);
    must(["git", "-C", repo.root, "worktree", "add", "-q", "--detach", worktree, sha]);
    for (let i = 1; i <= opts.runs; i++) {
      const log = join(dir, `run-${i}.log`);
      const r = await runTests(opts.command, worktree, opts.minutes * 60_000, log, (pid) => (group = pid));
      group = undefined;
      const tail = join(dir, `run-${i}.txt`);
      writeFileSync(tail, r.output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n") + "\n");
      rmSync(log, { force: true });
      runs.push({ code: r.code, ...(r.signal ? { signal: r.signal } : {}), timedOut: r.timedOut, tail, ...(r.code ? { failures: failingTests(r.output) } : {}) });
      // Another run would hang the same way and keep the failure notes back by another full time limit.
      if (r.timedOut) {
        note(hangNote(opts.base, opts.command, opts.minutes, dir));
        break;
      }
    }
    for (const text of failureNotes(opts.base, opts.command, runs, dir)) note(text);
    result = { base: opts.base, sha, command: opts.command, startedAt, finishedAt: new Date().toISOString(), runs, notes };
    writeJson(resultFile(repo), result);
  } finally {
    cleanUp();
    for (const s of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) process.off(s, onSignal);
  }

  const line = baselineLine(result, [...told]);
  notifyOrchestrator(repo, `[foreman baseline] ${line}`);
  return { result, line };
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

function removeWorktree(repo: Repo, worktree: string): void {
  if (existsSync(worktree)) run(["git", "-C", repo.root, "worktree", "remove", "--force", worktree]);
  rmSync(worktree, { recursive: true, force: true });
  run(["git", "-C", repo.root, "worktree", "prune"]);
}

const ranLine = (r: BaselineResult) => `\`${r.command}\` passed ${r.runs.filter((x) => x.code === 0).length} of ${r.runs.length} runs on ${r.base}`;

export function baselineLine(r: BaselineResult, told: string[] = []): string {
  const passed = r.runs.filter((x) => x.code === 0).length;
  const ran = ranLine(r);
  if (!r.notes.length) return passed === r.runs.length ? ran : `${ran}, and the notes already cover what failed`;
  const sent = told.length ? ` and sent ${r.notes.length > 1 ? "them" : "it"} to ${told.join(", ")}` : "";
  return `${ran}. Added ${r.notes.length} ${r.notes.length > 1 ? "notes" : "note"}${sent}. Read them with foreman notes`;
}

export function loadBaseline(repo: Repo): BaselineResult | undefined {
  return existsSync(resultFile(repo)) ? JSON.parse(readFileSync(resultFile(repo), "utf8")) : undefined;
}

export function baselineStatus(repo: Repo): string | undefined {
  const pid = readPid(pidFile(repo));
  if (pid) return pidAlive(pid) ? "baseline: running" : "baseline: stopped before it finished";
  const r = loadBaseline(repo);
  if (!r) return undefined;
  const added = r.notes.length ? `, added ${r.notes.length} ${r.notes.length > 1 ? "notes" : "note"}` : "";
  return `baseline: ${ranLine(r)}${added} (${r.finishedAt.slice(0, 16).replace("T", " ")})`;
}
