import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureForeman, type Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { loadTasks, type Task } from "./state.ts";
import { canHear } from "./lifecycle.ts";
import { withLock } from "./store.ts";

export type Note = { text: string; by: string; at: string };

const notesFile = (repo: Repo) => join(repo.foreman, "notes.jsonl");
export const notesDoc = (repo: Repo) => join(repo.foreman, "notes.md");

export function loadNotes(repo: Repo): Note[] {
  const path = notesFile(repo);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Note);
}

function withNotes<T>(repo: Repo, fn: (notes: Note[]) => T): T {
  mkdirSync(repo.foreman, { recursive: true });
  return withLock(join(repo.foreman, "notes.lock"), () => {
    const notes = loadNotes(repo);
    const result = fn(notes);
    writeFileSync(notesFile(repo), notes.map((n) => JSON.stringify(n) + "\n").join(""));
    writeFileSync(notesDoc(repo), renderNotes(notes));
    return result;
  });
}

// A second baseline run finds the same hang, and workers shouldn't hear about it twice.
export function addNote(repo: Repo, text: string, by: string): Note | undefined {
  const clean = text.trim();
  if (!clean) throw new Error("a note needs the fact it records");
  return withNotes(repo, (notes) => {
    if (notes.some((n) => n.text === clean)) return undefined;
    const note = { text: clean, by, at: new Date().toISOString() };
    notes.push(note);
    return note;
  });
}

export function removeNote(repo: Repo, n: number): Note {
  return withNotes(repo, (notes) => {
    if (!Number.isInteger(n) || n < 1 || n > notes.length) throw new Error(`there's no note ${n}. Run foreman notes to see them`);
    return notes.splice(n - 1, 1)[0]!;
  });
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function listNotes(notes: Note[]): string[] {
  return notes.map((n, i) => `${i + 1}. ${n.text} (${n.by}, ${when(n.at)})`);
}

function renderNotes(notes: Note[]): string {
  return [
    "# Notes about the setup",
    "",
    "Facts every worker should know about this repo. Check them before assuming a failing test is yours.",
    "",
    ...(notes.length ? listNotes(notes) : ["None yet."]),
    "",
  ].join("\n");
}

// Workers that are closed, paused or finished have no session to read a message, and the one that found the fact already knows it.
export function noteAudience(tasks: Task[], by: string): Task[] {
  return tasks.filter((t) => t.id !== by && canHear(t));
}

// A paused worker heard none of the notes added while its tab was closed, so its resume prompt carries them.
export function missedNotes(repo: Repo, since: string | undefined): string | undefined {
  const missed = since ? loadNotes(repo).filter((n) => n.at > since) : [];
  if (!missed.length) return undefined;
  return [`While you were paused, ${missed.length > 1 ? "these notes about the setup were" : "this note about the setup was"} added. Every note is in ${notesDoc(repo)}.`, ...missed.map((n) => `- ${n.text}`)].join("\n");
}

export type Shared = { sent: string[]; failed: string[] };

export function shareNote(repo: Repo, text: string, by: string, term: Terminal): Shared {
  const sent: string[] = [];
  const failed: string[] = [];
  for (const t of noteAudience(loadTasks(repo), by)) {
    try {
      sendToTask(repo, t, text, term);
      sent.push(t.id);
    } catch {
      failed.push(t.id);
    }
  }
  return { sent, failed };
}

export const toldLine = (s: Shared) => `Told: ${s.sent.join(", ") || "nobody"}${s.failed.length ? `. Couldn't reach: ${s.failed.join(", ")}` : ""}`;

export type NoteChange = { add: string } | { remove: number };

// Adds or removes a note, tells every worker that can hear it, and returns the line to show whoever asked.
export function changeNotes(repo: Repo, change: NoteChange, by: string, term: Terminal): string {
  ensureForeman(repo);
  if ("remove" in change) {
    const note = removeNote(repo, change.remove);
    return `removed note ${change.remove}: ${note.text}. ${toldLine(shareNote(repo, removedNoteMessage(note), by, term))}`;
  }
  const note = addNote(repo, change.add, by);
  if (!note) return "that note is already there";
  return `added note ${loadNotes(repo).length}. ${toldLine(shareNote(repo, newNoteMessage(repo, note), by, term))}`;
}

export const newNoteMessage = (repo: Repo, note: Note) => `${note.by} added a note about the setup. Every note is in ${notesDoc(repo)}.\n\n${note.text}`;
export const removedNoteMessage = (note: Note) => `This note about the setup turned out wrong and was removed, so ignore it.\n\n${note.text}`;

// Short notes go in the brief itself so the worker reads them before its first test run, and a long list stays behind the link.
const INLINE_CHARS = 600;

export function briefNotes(repo: Repo): string[] {
  const notes = loadNotes(repo);
  const add = "the note tool once you find a way past a hang or a failure that isn't yours";
  if (!notes.length) return [`- Notes about the setup: none yet. Add one with ${add}`];
  const head = `- Notes about the setup: ${notesDoc(repo)}. Check them before assuming a failing test is yours. Add one with ${add}`;
  const inline = notes.reduce((s, n) => s + n.text.length, 0) <= INLINE_CHARS;
  return inline ? [head, ...notes.map((n) => `  - ${n.text}`)] : [head];
}
