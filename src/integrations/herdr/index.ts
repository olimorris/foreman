import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Result } from "../../exec.ts";
import type { Check, Tab, Terminal } from "../../terminal.ts";

export type Exec = (cmd: string[]) => Result;

// Herdr 0.7.0 made pane ids stable handles, so a closed worker's pane id can't later point at someone else's pane.
const MIN_VERSION = [0, 7, 0];
// Herdr's split ratio is the share kept by the pane being split, so the status pane gets the other 35%.
const STATUS_SPLIT_RATIO = "0.65";

export function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The script a new Herdr pane runs: it deletes its own folder, moves into `cwd` and replaces the shell with `cmd`. */
export function launchScript(dir: string, cwd: string, cmd: string[]): string {
  return [`rm -rf ${quote(dir)}`, `cd ${quote(cwd)} || exit 1`, `exec ${cmd.map(quote).join(" ")}`, ""].join("\n");
}

// Herdr panes start the user's login shell, which may be fish, and `pane run` types into it, so the typed line must read the same in every shell.
export function typedCommand(script: string): string {
  if (/['\\]/.test(script)) throw new Error(`can't hand Herdr a script path containing ' or \\: ${script}`);
  return `exec /bin/sh '${script}'`;
}

function writeLaunchScript(cwd: string, cmd: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-herdr-"));
  const script = join(dir, "launch.sh");
  writeFileSync(script, launchScript(dir, cwd, cmd));
  return script;
}

export function tabCreateArgs(workspace: string, label: string, cwd: string): string[] {
  return ["herdr", "tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label, "--no-focus"];
}

export function workspaceCreateArgs(label: string, cwd: string): string[] {
  return ["herdr", "workspace", "create", "--cwd", cwd, "--label", label, "--focus"];
}

export function splitArgs(anchor: string, cwd: string): string[] {
  return ["herdr", "pane", "split", anchor, "--direction", "right", "--ratio", STATUS_SPLIT_RATIO, "--cwd", cwd, "--no-focus"];
}

/** Reads the root pane from `workspace create` or `tab create`, or the new pane from `pane split`. */
export function parseOpened(stdout: string): Tab {
  const result = JSON.parse(stdout)?.result;
  const pane = result?.root_pane ?? result?.pane;
  if (!pane?.pane_id || !pane.workspace_id) throw new Error(`Herdr didn't say which pane it opened: ${stdout.trim()}`);
  return { session: pane.workspace_id, window: pane.tab_id ?? result?.tab?.tab_id ?? "", pane: pane.pane_id };
}

/** Finds the workspace labelled `label` in `herdr workspace list`. */
export function findWorkspace(stdout: string, label: string): string | undefined {
  const workspaces: { workspace_id: string; label: string }[] = JSON.parse(stdout)?.result?.workspaces ?? [];
  return workspaces.find((ws) => ws.label === label)?.workspace_id;
}

/** The first pane in `herdr pane list --workspace`, which is the orchestrator's in a workspace `foreman up` made. */
export function firstPane(stdout: string): string | undefined {
  return JSON.parse(stdout)?.result?.panes?.[0]?.pane_id;
}

/** Reads `herdr pane get`. Herdr removes a pane once its process exits, so a pane it still knows is one whose worker is running. */
export function parseAlive(result: Result): boolean {
  if (result.code !== 0) return false;
  try {
    return Boolean(JSON.parse(result.stdout)?.result?.pane?.pane_id);
  } catch {
    return false;
  }
}

/** Herdr prints a failed request as a JSON error on stderr, which reads better as its message alone. */
export function errorText(result: Result): string {
  const text = (result.stderr || result.stdout).trim();
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

export function parseVersion(stdout: string): number[] | undefined {
  return stdout.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
}

export function versionAtLeast(version: number[], min = MIN_VERSION): boolean {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i]! > min[i]!;
  return true;
}

export function serverRunning(statusOutput: string): boolean {
  return /^status:\s*running\s*$/m.test(statusOutput);
}

export function herdrChecks(exec: Exec): Check[] {
  const version = exec(["herdr", "--version"]);
  // The PATH check already says herdr is missing, and a second failure here would only repeat it.
  if (version.code !== 0) return [];
  const found = parseVersion(version.stdout);
  const recent = found !== undefined && versionAtLeast(found);
  const running = serverRunning(exec(["herdr", "status", "server"]).stdout);
  return [
    {
      name: "herdr version",
      ok: recent,
      detail: recent ? found!.join(".") : `need Herdr ${MIN_VERSION.join(".")}+, found ${found?.join(".") ?? "an unknown version"} - run herdr update`,
    },
    { name: "herdr server", ok: running, detail: running ? "running" : "not running - start Herdr with herdr, then run foreman from a Herdr pane" },
  ];
}

function must(exec: Exec, cmd: string[]): string {
  const r = exec(cmd);
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${r.code}): ${errorText(r)}`);
  return r.stdout;
}

// A session is a Herdr workspace id. Every worker is a tab in the orchestrator's workspace and cds into its own worktree.
export function herdrTerminal(exec: Exec = run, script: (cwd: string, cmd: string[]) => string = writeLaunchScript): Terminal {
  const start = (tab: Tab, cwd: string, cmd: string[]): Tab => {
    must(exec, ["herdr", "pane", "run", tab.pane, typedCommand(script(cwd, cmd))]);
    return tab;
  };
  return {
    name: "Herdr",
    // Herdr before 0.9.2 leaves the outer terminal's TERM_PROGRAM in its panes, so only the pane id says Foreman is in Herdr.
    inside: (env) => env.TERM_PROGRAM === "herdr" || Boolean(env.HERDR_PANE_ID),
    currentSession: () => process.env.HERDR_WORKSPACE_ID || undefined,
    // Herdr sets HERDR_PANE_ID and the other HERDR_* ids fresh in every pane, so a worker never sees the orchestrator's.
    sessionEnv: [],
    requires: ["herdr"],
    checks: () => herdrChecks(exec),
    open(session, label, cwd, cmd) {
      return start(parseOpened(must(exec, tabCreateArgs(session, label, cwd))), cwd, cmd);
    },
    currentPane: () => process.env.HERDR_PANE_ID || undefined,
    openBeside(session, anchor, label, cwd, cmd) {
      const target = anchor ?? firstPane(must(exec, ["herdr", "pane", "list", "--workspace", session]));
      if (!target) throw new Error(`Herdr workspace ${session} has no pane to open beside`);
      const tab = parseOpened(must(exec, splitArgs(target, cwd)));
      exec(["herdr", "pane", "rename", tab.pane, label]);
      return start(tab, cwd, cmd);
    },
    newSession(name, cwd, cmd) {
      return start(parseOpened(must(exec, workspaceCreateArgs(name, cwd))), cwd, cmd).session;
    },
    findSession(name) {
      const r = exec(["herdr", "workspace", "list"]);
      return r.code === 0 ? findWorkspace(r.stdout, name) : undefined;
    },
    alive(tab) {
      return parseAlive(exec(["herdr", "pane", "get", tab.pane]));
    },
    // Not `pane run`, which pastes the text and Enter in one write: Herdr's own `agent prompt` delays the Enter so a coding agent doesn't read it as part of the paste.
    send(tab, text) {
      must(exec, ["herdr", "pane", "send-text", tab.pane, text]);
      must(exec, ["herdr", "pane", "send-keys", tab.pane, "enter"]);
    },
    close(tab) {
      exec(["herdr", "pane", "close", tab.pane]);
    },
  };
}

export const herdr = herdrTerminal();
