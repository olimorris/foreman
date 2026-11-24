import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAdrs } from "../src/adrwrite.ts";
import { saveConfig } from "../src/config.ts";
import { accept, overlaps, recipients, reject, writeIndex } from "../src/decisions.ts";
import { readEvents } from "../src/events.ts";
import { must, run } from "../src/exec.ts";
import { findDecision, propose, recordPath } from "../src/ledger.ts";
import type { Repo } from "../src/paths.ts";
import { withTasks, type Task } from "../src/state.ts";
import { fakeRex, tempRepo } from "./helpers.ts";

const task = (id: string, owns: string[], status: Task["status"] = "running"): Task => ({
  id, status, owns, branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, socket: "/nonexistent.sock",
  rex: { session: "s", window: `w-${id}`, block: `b-${id}` }, createdAt: "",
});

function withAdrs(repo: Repo): void {
  mkdirSync(join(repo.root, "docs/decisions"), { recursive: true });
  writeFileSync(join(repo.root, "docs/decisions/0001-native.md"), "# 1. Native app\n\nBody.\n");
  writeFileSync(join(repo.root, "docs/decisions/0002-files.md"), "# 2. One file per layer\n\nBody.\n");
  mkdirSync(join(repo.root, "docs/decisions/superseded"));
  writeFileSync(join(repo.root, "docs/decisions/superseded/.gitkeep"), "");
  must(["git", "-C", repo.root, "add", "."]);
  must(["git", "-C", repo.root, "commit", "-qm", "adrs"]);
}

test("overlaps compares the fixed part of each glob", () => {
  expect(overlaps(["src/export/**"], ["src/export/Writer.swift"])).toBe(true);
  expect(overlaps(["src/export/"], ["src/"])).toBe(true);
  expect(overlaps(["src/export/**"], ["src/capture/**"])).toBe(false);
  expect(overlaps([], ["anything"])).toBe(true);
});

test("recipients are the proposer plus in-flight tasks whose paths overlap", () => {
  const tasks = [task("T1", ["src/a/"]), task("T2", ["src/b/"]), task("T3", ["src/b/x.ts"], "torn-down"), task("T4", ["docs/"])];
  const d = { paths: ["src/b/**"], by: "T1" } as never;
  expect(recipients(tasks, d).map((t) => t.id)).toEqual(["T1", "T2"]);
});

describe("propose, accept and reject", () => {
  test("ids count up and each decision gets a readable record", () => {
    const repo = tempRepo();
    const a = propose(repo, { title: "Exports are H.264", body: "Why.", paths: ["src/export/"], supersedes: [], by: "T1" });
    const b = propose(repo, { title: "Second", body: "Why.", paths: [], supersedes: [2], by: "orchestrator" });
    expect([a.id, b.id]).toEqual(["D-1", "D-2"]);
    expect(readFileSync(recordPath(repo, "D-2"), "utf8")).toContain("- Supersedes: ADR 2");
    expect(() => propose(repo, { title: "x", body: " ", paths: [], supersedes: [], by: "T1" })).toThrow("needs a title and a body");
  });

  test("accept lets the orchestrator rewrite the text, tells the right workers and updates the index", () => {
    const repo = tempRepo();
    withAdrs(repo);
    withTasks(repo, (ts) => ts.push(task("T1", ["src/export/"]), task("T2", ["src/export/Codec.swift"]), task("T3", ["src/ui/"])));
    propose(repo, { title: "Exports are H.264", body: "Draft.", paths: ["src/export/**"], supersedes: [], by: "T1" });
    const rex = fakeRex();
    const r = accept(repo, "D-1", { title: "Exports are H.264 so every player opens them", body: "Final." }, rex);
    expect(r.sent).toEqual(["T1", "T2"]);
    expect(rex.sent).toHaveLength(2);
    expect(findDecision(repo, "D-1")).toMatchObject({ status: "accepted", title: "Exports are H.264 so every player opens them", body: "Final.", paths: ["src/export/**"] });
    const index = readFileSync(writeIndex(repo), "utf8");
    expect(index).toContain("- ADR 2: One file per layer - docs/decisions/0002-files.md");
    expect(index).toContain("- D-1: Exports are H.264 so every player opens them");
    expect(() => accept(repo, "D-1", {}, rex)).toThrow("already accepted");
  });

  test("reject needs a reason and tells only the proposer", () => {
    const repo = tempRepo();
    withTasks(repo, (ts) => ts.push(task("T1", ["src/"]), task("T2", ["src/"])));
    propose(repo, { title: "Use tabs", body: "Why.", paths: ["src/"], supersedes: [], by: "T1" });
    const rex = fakeRex();
    expect(() => reject(repo, "D-1", " ", rex)).toThrow("needs a reason");
    expect(reject(repo, "D-1", "the repo uses spaces", rex).sent).toEqual(["T1"]);
    const inbox = rex.sent[0]!.match(/read (\S+) and act/)![1]!;
    expect(readFileSync(inbox, "utf8")).toContain("the repo uses spaces");
  });
});

test("writeAdrs commits records on their own branch without touching the main checkout", () => {
  const repo = tempRepo();
  withAdrs(repo);
  saveConfig(repo, {});
  propose(repo, { title: "Workers own their folders", body: "Body.", paths: [], supersedes: [2], by: "T1" });
  accept(repo, "D-1", {}, fakeRex());
  const dry = writeAdrs(repo, { dryRun: true, push: false, base: "main", reserved: [] });
  expect(dry.files.map((f) => f.file)).toEqual(["docs/decisions/0003-workers-own-their-folders.md", "docs/decisions/superseded/0002-files.md"]);
  expect(findDecision(repo, "D-1").adr).toBeUndefined();

  const batch = writeAdrs(repo, { dryRun: false, push: false, base: "main" });
  const show = (path: string) => run(["git", "-C", repo.root, "show", `${batch.branch}:${path}`]);
  expect(show("docs/decisions/0003-workers-own-their-folders.md").stdout).toBe("# 3. Workers own their folders\n\nBody.\n");
  expect(show("docs/decisions/superseded/0002-files.md").stdout).toContain("Superseded by ADR 3.");
  expect(show("docs/decisions/0002-files.md").code).not.toBe(0);
  expect(existsSync(join(repo.root, "docs/decisions/0003-workers-own-their-folders.md"))).toBe(false);
  expect(run(["git", "-C", repo.root, "worktree", "list"]).stdout.trim().split("\n")).toHaveLength(1);
  expect(findDecision(repo, "D-1").adr).toEqual({ number: 3, file: "docs/decisions/0003-workers-own-their-folders.md", pr: undefined });
  expect(() => writeAdrs(repo, { dryRun: false, push: false, base: "main" })).toThrow("no accepted decisions");
});

test("a worker's proposal wakes the orchestrator through its task events", async () => {
  const repo = tempRepo();
  withTasks(repo, (ts) => ts.push(task("T1", ["src/"])));
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const p = Bun.spawnSync(["bun", cli, "propose", "Exports", "are", "H.264", "--body", "Why.", "--paths", "src/export/"], {
    cwd: repo.root, env: { ...process.env, FOREMAN_TASK: "T1" },
  });
  expect(p.stdout.toString()).toContain("proposed D-1");
  expect(readEvents(repo, "T1")).toMatchObject([{ type: "needs-decision", note: "D-1 Exports are H.264" }]);
});
