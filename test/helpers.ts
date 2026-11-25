import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.ts";
import { findRepo, type Repo } from "../src/paths.ts";
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
