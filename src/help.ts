import { banner } from "./banner.ts";
import { styleFor, type Style } from "./style.ts";

export { styleFor };

type Command = { usage: string; about: string; full?: string };
type Group = { title: string; commands: Command[] };

export const GROUPS: Group[] = [
  {
    title: "Start here",
    commands: [
      { usage: "doctor", about: "Check Foreman has everything it needs" },
      { usage: "version", about: "Print the installed version (also --version)", full: "version | --version" },
      { usage: "up", about: "Start the orchestrator in a new Rex session", full: "up [--model <name>]" },
    ],
  },
  {
    title: "Check on a run",
    commands: [
      { usage: "status [--json]", about: "What each task is doing" },
      { usage: "pane", about: "Open the status pane beside this tab" },
      { usage: "summary", about: "Write the run summary of PRs to review and show it" },
      { usage: "timeline [<task>]", about: "What happened when, and who waited" },
    ],
  },
  {
    title: "Steer a run",
    commands: [
      { usage: "workers", about: "How many workers run at once, and why" },
      { usage: "workers <n>", about: "Change how many run at once for this plan" },
      { usage: "automerge", about: "Whether Foreman merges approved PRs itself" },
      { usage: "automerge on|off", about: "Let Foreman merge approved PRs for this plan" },
      { usage: "resume <task>", about: "Reopen a stopped worker's session", full: "resume <task> [--model <name>]" },
      { usage: "restart <task>", about: "Close a worker and reopen its session", full: "restart <task> [--model <name>]" },
    ],
  },
  {
    title: "Spending",
    commands: [
      { usage: "budget", about: "What each task has spent against its limit" },
      { usage: "budget <usd>", about: "Set the limit for every task" },
      { usage: "budget <task> <usd>", about: "Set the limit for one task" },
      { usage: "budget --plan <usd>", about: "Set the limit for the whole plan" },
      { usage: "cost", about: "Spend split into workers and reviews" },
    ],
  },
  {
    title: "Notes about the setup",
    commands: [
      { usage: "notes", about: "List what workers should know about the setup" },
      { usage: 'note "<fact>"', about: "Add a note and send it to every worker" },
      { usage: "note --remove <n>", about: "Remove a note that turned out wrong" },
    ],
  },
  {
    title: "Run by Claude Code",
    commands: [
      { usage: "mcp", about: "Serve Foreman's tools to the orchestrator and workers" },
      { usage: "hook <event>", about: "Run one of Claude Code's hooks", full: "hook session-start | stop | pre-tool-use | permission-request | permission-denied" },
    ],
  },
];

// Commands that moved to the MCP server, each named after the tool that replaced it.
const ON_THE_SERVER = [
  "accept", "adr", "answer", "ask", "baseline", "decisions", "deliver", "feedback", "next", "pause", "plan", "propose",
  "reject", "report", "review", "send", "shots", "spawn", "sync", "teardown", "tidy", "together", "unblock", "watch",
];

export function goneText(command: string): string | undefined {
  if (!ON_THE_SERVER.includes(command)) return undefined;
  return `foreman: ${command} isn't a command anymore. The orchestrator and workers call the ${command} tool on Foreman's MCP server instead. Run foreman help to see the commands for people.`;
}

// The descriptions start in one column, so a usage longer than this puts its description on the next line.
const USAGE_WIDTH = 24;


export function helpText(style: Style = styleFor(), art = banner()): string {
  const lines = [...(art ? [art] : []), "Run a crew of Claude workers on one repo.", "", `Usage: foreman <command>`];
  for (const group of GROUPS) {
    lines.push("", style.heading(group.title));
    for (const c of group.commands) {
      if (c.usage.length <= USAGE_WIDTH) lines.push(`  ${c.usage.padEnd(USAGE_WIDTH)}  ${style.dim(c.about)}`);
      else lines.push(`  ${c.usage}`, `  ${" ".repeat(USAGE_WIDTH)}  ${style.dim(c.about)}`);
    }
  }
  return lines.join("\n");
}

export class UsageError extends Error {}

// A mistake gets only the forms of the command that was mistyped, not the whole help page.
export function usageError(command: string): UsageError {
  const forms = GROUPS.flatMap((g) => g.commands).filter((c) => c.usage === command || c.usage.startsWith(`${command} `)).map((c) => `foreman ${c.full ?? c.usage}`);
  const shown = forms.length ? forms : [`foreman ${command}`];
  return new UsageError([`usage: ${shown[0]}`, ...shown.slice(1).map((f) => `       ${f}`), "", "Run foreman help to see every command."].join("\n"));
}
