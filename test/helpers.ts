import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.ts";
import { findRepo, type Repo } from "../src/paths.ts";
import { roundDir, roundFiles, type Verdict } from "../src/rounds.ts";
import type { Terminal } from "../src/terminal.ts";

export function tempRepo(): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "foreman-test-")));
  const git = (...args: string[]) => must(["git", "-C", dir, ...args]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return findRepo(dir);
}

export function fakeTerminal(alive = true): Terminal & { sent: string[]; closed: string[]; labels: string[] } {
  const sent: string[] = [];
  const labels: string[] = [];
  const closed: string[] = [];
  return {
    sent,
    closed,
    labels,
    name: "Fake",
    currentSession: () => "session:1",
    sessionEnv: ["FAKE_SESSION"],
    requires: [],
    open: (session, label) => (labels.push(label), { session, window: "window:1", pane: "block:1" }),
    newSession: () => "session:1",
    findSession: () => undefined,
    alive: () => alive,
    send: (_tab, text) => void sent.push(text),
    close: (tab) => void closed.push(tab.window),
  };
}

// Writes a finished review round the way the reviewer leaves it, so tests read it back through rounds.ts.
export function writeRound(repo: Repo, id: string, n: number, round: { verdict?: Verdict; reviewer?: unknown; at?: Date; shots?: { before?: string[]; after?: string[] } } = {}): string {
  const dir = roundDir(repo, id, n);
  const files = roundFiles(dir);
  mkdirSync(dir, { recursive: true });
  if (round.verdict) writeFileSync(files.verdict, JSON.stringify(round.verdict));
  if (round.reviewer !== undefined) {
    writeFileSync(files.reviewer, typeof round.reviewer === "string" ? round.reviewer : JSON.stringify(round.reviewer));
    if (round.at) utimesSync(files.reviewer, round.at, round.at);
  }
  for (const side of ["before", "after"] as const) {
    for (const name of round.shots?.[side] ?? []) {
      mkdirSync(files[side], { recursive: true });
      writeFileSync(`${files[side]}/${name}.png`, "png");
    }
  }
  return dir;
}
