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
      { usage: "up", about: "Start the orchestrator in a new Rex session" },
    ],
  },
  {
    title: "Run a plan",
    commands: [
      { usage: "plan <file>", about: "Check a plan and store it" },
      { usage: "plan approve", about: "Approve the stored plan" },
      { usage: "plan show", about: "Show the stored plan" },
      { usage: "next [--max <n>]", about: "Start every task that's ready" },
      { usage: "status [--json]", about: "What each task is doing" },
      { usage: "pane", about: "Open the status pane beside this tab" },
      { usage: "summary", about: "Write the run summary of PRs to review and show it" },
    ],
  },
  {
    title: "Notes about the setup",
    commands: [
      { usage: "notes", about: "List what workers should know about the setup" },
      { usage: 'note "<fact>"', about: "Add a note and send it to every worker" },
      { usage: "note --remove <n>", about: "Remove a note that turned out wrong" },
      { usage: "baseline", about: "Run the tests on the base branch and note what fails", full: 'baseline [--runs <n>] [--test "<command>"]' },
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
    title: "Steer a task",
    commands: [
      { usage: "spawn <task>", about: "Start a task outside the plan", full: 'spawn <task> --title "<type>: <summary>" --brief <file> --owns <path>... [--base <branch>]' },
      { usage: "send <task> <message>", about: "Message a task's worker" },
      { usage: "pause <task>", about: "Stop a task's worker" },
      { usage: "resume <task>", about: "Reopen a stopped worker's session" },
      { usage: "restart <task>", about: "Close a worker and reopen its session" },
      { usage: "deliver <task>", about: "Push the branch and open the PR", full: 'deliver <task> [--title "<type>: <summary>"] [--dry-run]' },
      { usage: "teardown <task>", about: "Remove a finished task's tab, worktree and branch", full: "teardown <task> [--discard]" },
    ],
  },
  {
    title: "Decisions",
    commands: [
      { usage: "decisions [--all]", about: "List proposed and accepted decisions" },
      { usage: 'propose "<decision>"', about: "Propose a decision", full: 'propose "<decision>" (--body <why> | --body-file <file>) [--paths <glob>]... [--supersedes <adr>]... [--slug <name>]' },
      { usage: "accept <D-n>", about: "Accept a proposed decision", full: "accept <D-n> [--title <text>] [--body-file <file>] [--paths <glob>]... [--supersedes <adr>]... [--slug <name>]" },
      { usage: "reject <D-n>", about: "Reject a proposed decision", full: "reject <D-n> --reason <text>" },
      { usage: "adr <action>", about: "Detect, set up, write or index the ADR folder", full: "adr detect | init [--dir <path>] | write [--dry-run] [--no-push] | index" },
    ],
  },
  {
    title: "Used by Foreman itself",
    commands: [
      { usage: 'report done "<line>"', about: "A worker reports it has finished", full: 'report done "<one line>" --test "<step>"... [--assume "<assumption>"]...' },
      { usage: 'report <state> "<line>"', about: "A worker reports it's blocked, needs a decision or rebased", full: 'report blocked | needs-decision | rebased "<one line>"' },
      { usage: "review <task>", about: "Review a finished task" },
      { usage: "feedback <task>", about: "Send review feedback to a worker" },
      { usage: "shots <task>", about: "Screenshot a task's screens" },
      { usage: "sync", about: "Mark merged tasks and ask workers to rebase" },
      { usage: "watch", about: "Wait until something needs the orchestrator" },
      { usage: "hook <event>", about: "Run one of Claude Code's hooks", full: "hook session-start | stop | pre-tool-use" },
    ],
  },
];

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
