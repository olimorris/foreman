import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { must, run } from "../../exec.ts";
import type { Check, Tab, Terminal } from "../../terminal.ts";

const script = join(import.meta.dir, "ghostty.applescript");
const BUNDLE_ID = "com.mitchellh.ghostty";
// A terminal's tty and a tab's name override, which Foreman finds its tabs by, arrived in Ghostty 1.4.
const MIN_VERSION = [1, 4, 0];

export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// Ghostty runs a tab's command as `bash -c "exec -l <command>"`, and always keeps the tab open once it exits.
export function surfaceCommand(cmd: string[], keepOpen: boolean, applescript = script): string {
  const line = cmd.map(shellQuote).join(" ");
  if (keepOpen) return line;
  const closeSelf = `exec osascript ${shellQuote(applescript)} close-tty "$(tty)"`;
  return ["/usr/bin/env", "/bin/sh", "-c", `${line}; ${closeSelf}`].map(shellQuote).join(" ");
}

/** Walks up from `pid` in `ps -A -o pid=,ppid=,tty=` output to the first process with a terminal, since Claude Code runs commands detached from it. */
export function controllingTty(ps: string, pid: number): string | undefined {
  const procs = new Map<number, { ppid: number; tty: string }>();
  for (const line of ps.split("\n")) {
    const [p, pp, tty] = line.trim().split(/\s+/);
    if (p && pp && tty) procs.set(Number(p), { ppid: Number(pp), tty });
  }
  for (let at = pid, hops = 0; hops < 64; hops++) {
    const proc = procs.get(at);
    if (!proc) return undefined;
    if (proc.tty !== "??" && proc.tty !== "-") return proc.tty.startsWith("/dev/") ? proc.tty : `/dev/${proc.tty}`;
    if (proc.ppid <= 1) return undefined;
    at = proc.ppid;
  }
  return undefined;
}

export function parseTab(session: string, reply: string): Tab {
  const [window, pane] = reply.trim().split("\n");
  if (!window || !pane) throw new Error(`Ghostty didn't say which tab it opened: ${JSON.stringify(reply)}`);
  return { session, window, pane };
}

export function versionAtLeast(version: string, min = MIN_VERSION): boolean {
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== min[i]) return parts[i]! > min[i]!;
  return true;
}

export function appleScriptDisabled(showConfig: string): boolean {
  return /^macos-applescript\s*=\s*false\s*$/m.test(showConfig);
}

function osa(...args: string[]): string {
  return must(["osascript", script, ...args]).replace(/\n$/, "");
}

function pathEnv(): string {
  return `PATH=${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`;
}

let here: { terminal?: string } | undefined;

function hereTerminal(): string | undefined {
  if (!here) {
    here = {};
    if (process.env.TERM_PROGRAM === "ghostty") {
      const tty = controllingTty(run(["ps", "-A", "-o", "pid=,ppid=,tty="]).stdout, process.pid);
      if (tty) here.terminal = osa("whoami", tty) || undefined;
    }
  }
  return here.terminal;
}

function findApp(): string | undefined {
  const candidates = ["/Applications/Ghostty.app", join(homedir(), "Applications", "Ghostty.app")];
  const found = candidates.find((app) => existsSync(app));
  if (found) return found;
  const spotlight = run(["mdfind", `kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`]).stdout.split("\n")[0]?.trim();
  return spotlight || undefined;
}

function checks(): Check[] {
  const app = findApp();
  if (!app) return [{ name: "ghostty", ok: false, detail: "Ghostty.app not found - install Ghostty 1.4 or later from ghostty.org" }];
  const version = run(["plutil", "-extract", "CFBundleShortVersionString", "raw", join(app, "Contents", "Info.plist")]).stdout.trim();
  const recent = versionAtLeast(version);
  const config = run([join(app, "Contents", "MacOS", "ghostty"), "+show-config"]).stdout;
  const scripting = !appleScriptDisabled(config);
  return [
    { name: "ghostty", ok: recent, detail: recent ? version : `need Ghostty ${MIN_VERSION.join(".")}+, found ${version || "an unknown version"}` },
    { name: "ghostty applescript", ok: scripting, detail: scripting ? "enabled" : "remove macos-applescript = false from your Ghostty config" },
  ];
}

// A session is the terminal Foreman was run from: Ghostty's window ids change as tabs come and go, but a terminal's id lasts as long as it does.
export const ghostty: Terminal = {
  name: "Ghostty",
  currentSession: hereTerminal,
  // Ghostty gives each tab its own GHOSTTY_SURFACE_ID, so a worker never inherits the orchestrator's.
  sessionEnv: [],
  requires: ["osascript"],
  checks,
  open(session, label, cwd, cmd, keepOpen = true) {
    return parseTab(session, osa("open", session, label, cwd, pathEnv(), surfaceCommand(cmd, keepOpen)));
  },
  currentPane: hereTerminal,
  openBeside(session, anchor, label, cwd, cmd) {
    return parseTab(session, osa("split", anchor ?? session, label, cwd, pathEnv(), surfaceCommand(cmd, true)));
  },
  newSession(name, cwd, cmd) {
    return osa("new-session", name, cwd, pathEnv(), surfaceCommand(cmd, true));
  },
  findSession(name) {
    return osa("find-session", name) || undefined;
  },
  alive(tab) {
    const tty = run(["osascript", script, "tty", tab.pane]).stdout.trim();
    // Ghostty keeps a tab open after its command exits, so the tab existing isn't enough.
    return tty !== "" && run(["ps", "-o", "pid=", "-t", tty]).stdout.trim() !== "";
  },
  send(tab, text) {
    osa("send", tab.pane, text);
  },
  close(tab) {
    run(["osascript", script, "close", tab.window, tab.pane]);
  },
};
