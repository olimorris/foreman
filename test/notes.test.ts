import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, briefNotes, listNotes, loadNotes, newNoteMessage, notesDoc, removeNote, shareNote } from "../src/notes.ts";
import { spawn } from "../src/spawn.ts";
import { withTasks, type Task } from "../src/state.ts";
import { fakeTerminal, tempRepo } from "./helpers.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "foreman-claude-"));

const task = (id: string, status: Task["status"] = "running"): Task => ({
  id, status, owns: ["src/"], branch: `foreman/${id}`, base: "main", worktree: `/w/${id}`, socket: "/nonexistent.sock",
  tab: { session: "s", window: `w-${id}`, pane: `b-${id}` }, createdAt: "",
});

test("notes are numbered, kept in a readable file, and removed by number", () => {
  const repo = tempRepo();
  addNote(repo, "`swift test -j 3` deadlocks on main, use -j 1", "T2");
  addNote(repo, "the simulator needs a reset after a crash", "orchestrator");
  expect(addNote(repo, "the simulator needs a reset after a crash", "T3")).toBeUndefined();
  expect(listNotes(loadNotes(repo))).toEqual([
    expect.stringMatching(/^1\. `swift test -j 3` deadlocks on main, use -j 1 \(T2, \d{4}-\d\d-\d\d \d\d:\d\d\)$/),
    expect.stringMatching(/^2\. the simulator needs a reset after a crash \(orchestrator, /),
  ]);
  expect(readFileSync(notesDoc(repo), "utf8")).toContain("1. `swift test -j 3` deadlocks");

  expect(removeNote(repo, 1).by).toBe("T2");
  expect(loadNotes(repo).map((n) => n.text)).toEqual(["the simulator needs a reset after a crash"]);
  expect(readFileSync(notesDoc(repo), "utf8")).not.toContain("deadlocks");
  expect(() => removeNote(repo, 5)).toThrow("there's no note 5");
});

test("a new note reaches every running worker except the one that added it", () => {
  const repo = tempRepo();
  withTasks(repo, (tasks) => tasks.push(task("T1"), task("T2", "done"), task("T3"), task("T4", "exited"), task("T5", "torn-down"), task("T6", "over-budget")));
  const term = fakeTerminal();
  const note = addNote(repo, "port 3000 is taken on this machine", "T3")!;
  expect(shareNote(repo, newNoteMessage(repo, note), "T3", term)).toEqual({ sent: ["T1", "T2"], failed: [] });
  expect(term.sent).toHaveLength(2);
  const inbox = term.sent[0]!.match(/read (\S+) and act/)![1]!;
  expect(readFileSync(inbox, "utf8")).toContain("T3 added a note about the setup");
});

test("a new brief lists short notes inline and links the file", () => {
  const repo = tempRepo();
  expect(briefNotes(repo)).toEqual([expect.stringContaining("Notes about the setup: none yet")]);
  addNote(repo, "`swift test -j 3` deadlocks on main, use -j 1", "T2");
  const brief = join(repo.root, "..", `brief-${Date.now()}.md`);
  writeFileSync(brief, "## Intent\n\nHi.\n\n## Spec\n\nHi.\n");
  spawn(repo, { id: "T1", brief, owns: ["x"], base: "main", session: "s" }, fakeTerminal());
  const header = readFileSync(join(repo.foreman, "tasks", "T1", "brief.md"), "utf8");
  expect(header).toContain(`- Notes about the setup: ${notesDoc(repo)}.`);
  expect(header).toContain("  - `swift test -j 3` deadlocks on main, use -j 1");

  addNote(repo, "x".repeat(700), "T2");
  expect(briefNotes(repo)).toHaveLength(1);
});
