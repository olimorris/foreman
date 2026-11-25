export type Tab = { session: string; window: string; pane: string };

export type Check = { name: string; ok: boolean; detail: string };

export type Env = Record<string, string | undefined>;

export type Terminal = {
  name: string;
  /** Whether a process with this environment runs inside this terminal. Foreman uses the one that says yes when `FOREMAN_TERMINAL` isn't set. */
  inside?(env: Env): boolean;
  /** The session Foreman was run from, or undefined outside this terminal. */
  currentSession(): string | undefined;
  /** Variables this terminal sets that a worker must not inherit, or a user hook in the worker would act on the orchestrator's session. */
  sessionEnv: string[];
  /** Binaries that must be on PATH for this terminal. */
  requires: string[];
  /** Requirements `foreman doctor` can't check as binaries on PATH, such as an app's version or a setting. */
  checks?(): Check[];
  open(session: string, label: string, cwd: string, cmd: string[], keepOpen?: boolean): Tab;
  /** The pane Foreman was run from, or undefined outside this terminal. */
  currentPane?(): string | undefined;
  /** Opens a pane beside another in the same tab, or beside the session's first pane when none is given. Optional: without it, Foreman opens a tab instead. */
  openBeside?(session: string, anchor: string | undefined, label: string, cwd: string, cmd: string[]): Tab;
  newSession(name: string, cwd: string, cmd: string[]): string;
  findSession(name: string): string | undefined;
  alive(tab: Tab): boolean;
  send(tab: Tab, text: string): void;
  close(tab: Tab): void;
};

export function requireSession(term: Terminal, command: string): string {
  const session = term.currentSession();
  if (!session) throw new Error(`run foreman ${command} from inside ${term.name}`);
  return session;
}
