import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Result } from "../../exec.ts";
import type { Tab, Terminal } from "../../terminal.ts";

export type Exec = (cmd: string[]) => Result;

export function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The script a new Orca tab runs: it deletes its own folder, moves into `cwd` and replaces the shell with `cmd`. */
export function launchScript(dir: string, cwd: string, cmd: string[]): string {
  return [`rm -rf ${quote(dir)}`, `cd ${quote(cwd)} || exit 1`, `exec ${cmd.map(quote).join(" ")}`, ""].join("\n");
}

// Orca types --command into the user's login shell, which may be fish, so the typed line must read the same in every shell.
export function typedCommand(script: string): string {
  if (/['\\]/.test(script)) throw new Error(`can't hand Orca a script path containing ' or \\: ${script}`);
  return `exec /bin/sh '${script}'`;
}

function writeLaunchScript(cwd: string, cmd: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-orca-"));
  const script = join(dir, "launch.sh");
  writeFileSync(script, launchScript(dir, cwd, cmd));
  return script;
}

export function createArgs(worktree: string, title: string, command: string, focus = false): string[] {
  return ["orca", "terminal", "create", "--worktree", worktree, "--title", title, "--command", command, ...(focus ? ["--focus"] : []), "--json"];
}

export function parseCreate(stdout: string): Tab {
  const terminal = JSON.parse(stdout)?.result?.terminal;
  if (!terminal?.handle || !terminal.worktreeId) throw new Error(`Orca didn't say which terminal it opened: ${stdout.trim()}`);
  return { session: terminal.worktreeId, window: terminal.tabId ?? "", pane: terminal.handle };
}

/** Reads `orca terminal show --json`. A handle Orca no longer knows, such as one from before Orca restarted, counts as gone. */
export function parseAlive(result: Result): boolean {
  if (result.code !== 0) return false;
  const terminal = JSON.parse(result.stdout)?.result?.terminal;
  if (!terminal || terminal.exitCause) return false;
  if (terminal.verdict === "exited") return false;
  if (terminal.verdict === "live") return true;
  return terminal.connected === true;
}

type LayoutNode = { type: "group"; tabs: { title: string | null }[] } | { type: "split"; first: LayoutNode; second: LayoutNode };

/** Finds the workspace holding a tab titled `title` in `orca terminal list --include-visual-layouts --json`. */
export function findTabWorkspace(stdout: string, title: string): string | undefined {
  const layouts: { worktreeId: string; root: LayoutNode }[] = JSON.parse(stdout)?.result?.visualLayouts ?? [];
  const hasTab = (node: LayoutNode): boolean =>
    node.type === "group" ? node.tabs.some((tab) => tab.title === title) : hasTab(node.first) || hasTab(node.second);
  return layouts.find((layout) => hasTab(layout.root))?.worktreeId;
}

function must(exec: Exec, cmd: string[]): string {
  const r = exec(cmd);
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// A session is an Orca workspace id. Every tab opens in the orchestrator's workspace and cds into its folder, so Orca never makes worktrees of its own.
export function orcaTerminal(exec: Exec = run, script: (cwd: string, cmd: string[]) => string = writeLaunchScript): Terminal {
  const create = (worktree: string, label: string, cwd: string, cmd: string[], focus = false) =>
    parseCreate(must(exec, createArgs(worktree, label, typedCommand(script(cwd, cmd)), focus)));
  return {
    name: "Orca",
    inside: (env) => env.TERM_PROGRAM === "Orca",
    currentSession: () => process.env.ORCA_WORKTREE_ID || undefined,
    // Orca stamps every new pane with its own ORCA_* identity, and stripping it would stop Orca showing the worker's status.
    sessionEnv: [],
    requires: ["orca"],
    open(session, label, cwd, cmd) {
      return create(`id:${session}`, label, cwd, cmd);
    },
    newSession(name, cwd, cmd) {
      return create(`path:${cwd}`, name, cwd, cmd, true).session;
    },
    findSession(name) {
      const r = exec(["orca", "terminal", "list", "--include-visual-layouts", "--json"]);
      return r.code === 0 ? findTabWorkspace(r.stdout, name) : undefined;
    },
    alive(tab) {
      return parseAlive(exec(["orca", "terminal", "show", "--terminal", tab.pane, "--json"]));
    },
    send(tab, text) {
      must(exec, ["orca", "terminal", "send", "--terminal", tab.pane, "--text", text, "--enter", "--json"]);
    },
    close(tab) {
      exec(["orca", "terminal", "close", "--terminal", tab.pane, "--json"]);
    },
  };
}

export const orca = orcaTerminal();
