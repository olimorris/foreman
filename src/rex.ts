import { join } from "node:path";
import { must, run } from "./exec.ts";
import { pluginRoot } from "./paths.ts";

const script = join(pluginRoot, "scripts", "rex.sh");

// Rex resolves a block or window id only within the session it's scoped to.
export type Tab = { session: string; window: string; block: string };

export type Rex = {
  open(session: string, label: string, cwd: string, cmd: string[], keepOpen?: boolean): Tab;
  newSession(name: string, cwd: string, cmd: string[]): string;
  findSession(name: string): string | undefined;
  alive(tab: Tab): boolean;
  send(tab: Tab, text: string): void;
  close(tab: Tab): void;
};

export const rex: Rex = {
  open(session, label, cwd, cmd, keepOpen = true) {
    const out = JSON.parse(must(["sh", script, "open", session, label, cwd, keepOpen ? "yes" : "no", "--", ...cmd]));
    return { session, window: out.window_id, block: out.block_ids[0] };
  },
  newSession(name, cwd, cmd) {
    return JSON.parse(must(["sh", script, "new-session", name, cwd, "--", ...cmd])).session_id;
  },
  findSession(name) {
    const out = run(["sh", script, "find-session", name]).stdout.trim();
    return out ? (JSON.parse(out).session_id ?? JSON.parse(out).id) : undefined;
  },
  alive(tab) {
    return run(["sh", script, "alive", tab.session, tab.block]).code === 0;
  },
  send(tab, text) {
    must(["sh", script, "send", tab.session, tab.block, text]);
  },
  close(tab) {
    run(["sh", script, "close", tab.session, tab.window]);
  },
};
