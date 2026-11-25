import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./paths.ts";
import type { Terminal } from "./terminal.ts";
import { sendToTask } from "./send.ts";
import { inFlight, loadTasks, type Task } from "./state.ts";
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

// Workers that are closed, stopped or finished have no session to read a message, and the one that found the fact already knows it.
export function noteAudience(tasks: Task[], by: string): Task[] {
  return inFlight(tasks).filter((t) => t.id !== by && t.tab && !["exited", "over-budget", "merged"].includes(t.status));
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
