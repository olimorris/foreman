import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { run } from "./exec.ts";
import type { Repo } from "./paths.ts";
import { baseRef } from "./base.ts";
import type { Task } from "./state.ts";
import { writeJson } from "./store.ts";
import { pidAlive } from "./procs.ts";
import { readPid } from "./watch.ts";
import { andList } from "./text.ts";
import { runTests, TEST_MINUTES } from "./testrun.ts";

export type Tested = { id: string; pr: number; branch: string; sha: string };
export type Conflict = { id: string; with: string[]; files: string[] };
export type TestRun = { status: "pass" | "fail" | "timeout" | "not-run"; reason?: "no-command" | "too-few"; failure?: string; minutes?: number; onBase?: boolean };
export type Together = { at: string; base: string; baseSha: string; tested: Tested[]; merged: string[]; conflicts: Conflict[]; tests: TestRun };
export type Runner = (cmd: string, cwd: string, minutes: number, signal?: AbortSignal) => Promise<{ status: "pass" | "fail" | "timeout"; output: string }>;

const TAIL_LINES = 40;

export const togetherDir = (repo: Repo) => join(repo.foreman, "together");
const resultPath = (repo: Repo) => join(repo.foreman, "together.json");
export const outputPath = (repo: Repo) => join(togetherDir(repo), "test-output.txt");

export function loadTogether(repo: Repo): Together | undefined {
  return existsSync(resultPath(repo)) ? JSON.parse(readFileSync(resultPath(repo), "utf8")) : undefined;
}

const files = (paths: string[]) => andList(paths.length > 3 ? [...paths.slice(0, 3).map((p) => basename(p)), `${paths.length - 3} more`] : paths.map((p) => basename(p)));

export function togetherLine(t: Together): string {
  const pr = (id: string) => `#${t.tested.find((x) => x.id === id)?.pr ?? id}`;
  const merged = andList(t.merged.map(pr));
  const parts = t.conflicts.map((c) =>
    !c.files.length ? `${pr(c.id)} doesn't merge`
    : c.with.length ? `${andList([...c.with, c.id].map(pr))} conflict in ${files(c.files)}`
    : `${pr(c.id)} conflicts with ${t.base} in ${files(c.files)}`);
  const clean = !t.conflicts.length;
  const { tests } = t;
  if (tests.status === "pass") parts.push(clean ? `${t.merged.length} PRs merge cleanly and the tests pass` : `the tests pass with ${merged} merged`);
  if (tests.status === "fail") parts.push(`tests fail ${tests.onBase ? `on ${t.base} too` : `with ${merged} merged`}${tests.failure ? `: ${tests.failure}` : ""}`);
  if (tests.status === "timeout") parts.push(`tests ran past ${tests.minutes} minutes with ${merged} merged, so Foreman stopped them`);
  if (tests.reason === "no-command") {
    parts.push(`${clean ? `${t.merged.length} PRs merge cleanly, but the` : "the"} tests weren't run: there's no test command in .foreman/config.json`);
  }
  return `together: ${parts.join("; ")}`;
}

// Each test runner prints a failure its own way, and naming the failing test saves opening the log to find it.
const FAILURES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/Test Case '-\[(?:\w+\.)?(\w+) (\w+)\]' failed/, (m) => `${m[1]}.${m[2]}`],
  [/✘ Test (.+?) (?:failed|recorded)/, (m) => m[1]!.replace(/^"|"$/g, "")],
  [/^--- FAIL: (\S+)/m, (m) => m[1]!],
  [/^FAILED (\S+)/m, (m) => m[1]!],
  [/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/m, (m) => m[1]!],
  [/^\s*✕ (.+?)(?: \(\d+ ?m?s\))?$/m, (m) => m[1]!],
];

export function failureHint(output: string): string | undefined {
  for (const [re, name] of FAILURES) {
    const m = output.match(re);
    if (m) return name(m).trim();
  }
  const line = output.split("\n").map((l) => l.trim()).filter((l) => /\b(fail|failed|failure|error)\b/i.test(l)).at(-1);
  return line && (line.length > 100 ? line.slice(0, 97) + "..." : line);
}

const runShared: Runner = async (cmd, cwd, minutes, signal) => {
  const r = await runTests(cmd, cwd, { minutes, signal });
  return { status: r.timedOut ? "timeout" : r.code === 0 ? "pass" : "fail", output: r.output };
};

export type TogetherOptions = { runner?: Runner; fetch?: boolean; signal?: AbortSignal };

const lockFile = (repo: Repo) => join(togetherDir(repo), "pid");
const rerunFile = (repo: Repo) => join(togetherDir(repo), "rerun");

// Two calls landing together would share one worktree, and the second would remove it mid-test, so only the exclusive create wins.
function lock(repo: Repo): number | undefined {
  mkdirSync(togetherDir(repo), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lockFile(repo), String(process.pid), { flag: "wx" });
      return undefined;
    } catch {
      const other = readPid(lockFile(repo));
      if (other && pidAlive(other)) return other;
      rmSync(lockFile(repo), { force: true });
    }
  }
  return readPid(lockFile(repo)) ?? -1;
}

// A PR delivered while a check runs would otherwise never be checked, so the skipped call leaves a note and the running one goes again.
export async function together(repo: Repo, base: string, prs: () => Task[], opts: TogetherOptions = {}): Promise<{ line: string; result?: Together }> {
  if (prs().length < 2) return check(repo, base, prs(), opts);
  const other = lock(repo);
  if (other !== undefined) {
    writeFileSync(rerunFile(repo), "");
    return { line: `together: already running (pid ${other}), so it checks again with the latest PRs when it finishes` };
  }
  try {
    let outcome: { line: string; result?: Together };
    do {
      rmSync(rerunFile(repo), { force: true });
      outcome = await check(repo, base, prs(), opts);
    } while (existsSync(rerunFile(repo)) && !opts.signal?.aborted);
    return outcome;
  } finally {
    rmSync(lockFile(repo), { force: true });
  }
}

async function check(repo: Repo, base: string, prs: Task[], opts: TogetherOptions): Promise<{ line: string; result?: Together }> {
  if (prs.length < 2) return { line: `together: ${prs.length ? `only #${prs[0]!.pr} is` : "no PRs are"} open, so there's nothing to test together` };
  const git = (...args: string[]) => run(["git", "-C", repo.root, ...args]);
  // A repo's hooks can be slow or refuse these throwaway merges, and a machine with no git identity can't make them at all.
  const quiet = ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Foreman", "-c", "user.email=foreman@localhost"];
  const worktree = join(togetherDir(repo), "worktree");
  const removeWorktree = () => {
    git("worktree", "remove", "--force", worktree);
    rmSync(worktree, { recursive: true, force: true });
    git("worktree", "prune");
  };
  try {
    if (opts.fetch && git("remote", "get-url", "origin").code === 0) git("fetch", "-q", "origin", base);
    const baseSha = git("rev-parse", baseRef(repo, base)).stdout.trim();
    const tested: Tested[] = prs.map((t) => ({ id: t.id, pr: t.pr!, branch: t.branch, sha: git("rev-parse", "--verify", "-q", t.branch).stdout.trim() }));
    const missing = tested.find((t) => !t.sha);
    if (missing) throw new Error(`${missing.id}'s branch ${missing.branch} doesn't exist`);

    removeWorktree();
    const added = run(["git", ...quiet, "-C", repo.root, "worktree", "add", "-q", "--detach", worktree, baseSha]);
    if (added.code !== 0) throw new Error(`couldn't make the worktree: ${added.stderr.trim()}`);
    const inTree = (...args: string[]) => run(["git", ...quiet, "-C", worktree, ...args]);
    const changed = new Map<string, string[]>();
    const changedBy = (t: Tested) => changed.get(t.id) ?? changed.set(t.id, git("diff", "--name-only", `${baseSha}...${t.sha}`).stdout.split("\n").filter(Boolean)).get(t.id)!;

    const merged: string[] = [];
    const conflicts: Conflict[] = [];
    for (const t of tested) {
      if (inTree("merge", "--no-ff", "--no-edit", "-m", `Merge #${t.pr} (${t.id})`, t.sha).code === 0) {
        merged.push(t.id);
        continue;
      }
      const clash = inTree("diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
      inTree("merge", "--abort");
      const earlier = tested.filter((e) => merged.includes(e.id) && changedBy(e).some((f) => clash.includes(f))).map((e) => e.id);
      conflicts.push({ id: t.id, with: earlier, files: clash });
    }

    const { test, testMinutes = TEST_MINUTES } = loadConfig(repo);
    const runner = opts.runner ?? runShared;
    rmSync(outputPath(repo), { force: true });
    let tests: TestRun;
    if (!test) tests = { status: "not-run", reason: "no-command" };
    else if (merged.length < 2) tests = { status: "not-run", reason: "too-few" };
    else {
      const stopped = () => {
        if (opts.signal?.aborted) throw new Error("together: stopped before the tests finished");
      };
      stopped();
      const r = await runner(test, worktree, testMinutes, opts.signal);
      // Tests killed because the task was cancelled say nothing about the PRs.
      stopped();
      const tail = r.output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
      writeFileSync(outputPath(repo), tail + "\n");
      tests = { status: r.status, minutes: testMinutes, ...(r.status === "fail" ? { failure: failureHint(tail) } : {}) };
      if (r.status === "fail") {
        // A test that already fails on the base branch would otherwise be blamed on the PRs.
        inTree("reset", "-q", "--hard", baseSha);
        inTree("clean", "-qffdx");
        if ((await runner(test, worktree, testMinutes, opts.signal)).status === "fail") tests.onBase = true;
        stopped();
      }
    }

    const result: Together = { at: new Date().toISOString(), base, baseSha, tested, merged, conflicts, tests };
    writeJson(resultPath(repo), result);
    return { line: togetherLine(result), result };
  } finally {
    removeWorktree();
  }
}

// The advice is only as good as the branches it tested, so the summary says which PRs changed since.
export function staleness(t: Together, open: Tested[]): string[] {
  const now = (id: string) => open.find((o) => o.id === id);
  return [
    ...t.tested.filter((x) => now(x.id) && now(x.id)!.sha !== x.sha).map((x) => `#${x.pr}'s branch moved`),
    ...t.tested.filter((x) => !now(x.id)).map((x) => `#${x.pr} merged or closed`),
    ...open.filter((o) => !t.tested.some((x) => x.id === o.id)).map((o) => `#${o.pr} opened`),
  ];
}

export function renderTogether(t: Together, stale: string[]): string[] {
  const pr = (id: string) => `#${t.tested.find((x) => x.id === id)?.pr ?? id}`;
  const paths = (fs: string[]) => fs.map((f) => `\`${f}\``).join(", ");
  const merged = andList(t.merged.map(pr));
  const { tests } = t;
  const lines = t.conflicts.map((c) =>
    !c.files.length ? `- ${pr(c.id)} doesn't merge onto the others. Its worker needs to look at why.`
    : c.with.length ? `- ${pr(c.id)} conflicts with ${andList(c.with.map(pr))} in ${paths(c.files)}. Merge ${andList(c.with.map(pr))} first, and Foreman then asks ${pr(c.id)}'s worker to rebase.`
    : `- ${pr(c.id)} conflicts with ${t.base} in ${paths(c.files)}. Its worker needs to rebase before it can merge.`);
  if (tests.status === "pass") lines.push(t.conflicts.length ? `- With ${merged} merged together, the tests pass.` : `- All ${t.merged.length} open PRs merge cleanly together and the tests pass, so merge them in any order.`);
  if (tests.status === "fail" && tests.onBase) lines.push(`- The tests fail on ${t.base} too${tests.failure ? `: \`${tests.failure}\`` : ""}, so they say nothing about these PRs. Fix ${t.base}'s tests, then ask the orchestrator to run the together check again.`);
  if (tests.status === "fail" && !tests.onBase) lines.push(`- The tests fail with ${merged} merged together${tests.failure ? `: \`${tests.failure}\`` : ""}. Don't merge them all until that's fixed. The end of the output is in \`.foreman/together/test-output.txt\`.`);
  if (tests.status === "timeout") lines.push(`- The tests ran past ${tests.minutes} minutes with ${merged} merged, so Foreman stopped them. Raise \`testMinutes\` in \`.foreman/config.json\` if the suite is that slow.`);
  if (tests.reason === "no-command") lines.push(`- ${t.conflicts.length ? "" : `All ${t.merged.length} open PRs merge cleanly together. `}The tests weren't run, because \`.foreman/config.json\` has no test command.`);
  return [
    "## Open PRs together",
    "",
    ...(stale.length ? [`Out of date: ${andList(stale)} since this was checked. Ask the orchestrator to run the together check again.`, ""] : []),
    ...lines,
    "",
  ];
}
