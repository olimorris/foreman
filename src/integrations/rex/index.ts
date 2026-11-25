import { join } from "node:path";
import { must, run } from "../../exec.ts";
import type { Terminal } from "../../terminal.ts";

const script = join(import.meta.dir, "rex.sh");

type Env = Record<string, string | undefined>;

// Rex accepts a block id where a session goes, so the id is the fallback when inspecting the block fails.
export function sessionFor(env: Env, sessionOfBlock: (block: string) => string | undefined): string | undefined {
  if (env.REX_SESSION) return env.REX_SESSION;
  const block = env.REX_BLOCK;
  if (!block) return undefined;
  return sessionOfBlock(block) || block;
}

function sessionOfBlock(block: string): string | undefined {
  const r = run(["sh", script, "block-session", block]);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

// Rex resolves a block or window id only within the session it's scoped to, so every tab keeps its session.
export const rex: Terminal = {
  name: "Rex",
  inside: (env) => env.TERM_PROGRAM === "rex",
  currentSession: () => sessionFor(process.env, sessionOfBlock),
  sessionEnv: ["REX_SESSION", "REX_BLOCK"],
  requires: ["rex"],
  open(session, label, cwd, cmd, keepOpen = true) {
    const out = JSON.parse(must(["sh", script, "open", session, label, cwd, keepOpen ? "yes" : "no", "--", ...cmd]));
    return { session, window: out.window_id, pane: out.block_ids[0] };
  },
  currentPane: () => process.env.REX_BLOCK || undefined,
  openBeside(session, anchor, label, cwd, cmd) {
    const out = JSON.parse(must(["sh", script, "split", session, anchor ?? "", label, cwd, "--", ...cmd]));
    return { session, window: out.window_id, pane: out.block_id ?? out.block_ids?.[0] };
  },
  newSession(name, cwd, cmd) {
    return JSON.parse(must(["sh", script, "new-session", name, cwd, "--", ...cmd])).session_id;
  },
  findSession(name) {
    const out = run(["sh", script, "find-session", name]).stdout.trim();
    return out ? (JSON.parse(out).session_id ?? JSON.parse(out).id) : undefined;
  },
  alive(tab) {
    return run(["sh", script, "alive", tab.session, tab.pane]).code === 0;
  },
  send(tab, text) {
    must(["sh", script, "send", tab.session, tab.pane, text]);
  },
  close(tab) {
    run(["sh", script, "close", tab.session, tab.window]);
  },
};
