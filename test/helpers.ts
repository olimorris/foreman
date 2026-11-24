import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.ts";
import { findRepo, type Repo } from "../src/paths.ts";
import type { Rex } from "../src/rex.ts";

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

export function fakeRex(alive = true): Rex & { sent: string[]; closed: string[] } {
  const sent: string[] = [];
  const closed: string[] = [];
  return {
    sent,
    closed,
    open: (session) => ({ session, window: "window:1", block: "block:1" }),
    newSession: () => "session:1",
    findSession: () => undefined,
    alive: () => alive,
    send: (_tab, text) => void sent.push(text),
    close: (tab) => void closed.push(tab.window),
  };
}
