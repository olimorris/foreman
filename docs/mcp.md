# Foreman's MCP server

The `foreman` CLI is for people. The MCP server, started by `foreman mcp`, is for the orchestrator and workers. D-16 records the split. D-17 and D-21 cover the MCP tasks. All three reach `docs/decisions/` in the next decisions PR. `docs/findings.md` has what was checked against Claude Code.

## Why

Agents used to run `foreman` commands through the Bash tool.

- Text with quotes, backticks or `$` needed `--body-file` to survive the shell.
- `Bash(foreman *)` let a worker run `foreman accept` on its own proposal.
- `foreman help` listed about 30 commands people never run.

An earlier version of this note argued against a server, because every command would need two front doors. D-16 gives each command one home instead. Agent commands leave the CLI, and commands both need share one implementation.

## What was built

- `src/mcp.ts` is a stdio JSON-RPC server with no SDK. It speaks protocol 2026-07-28 through `server/discover`, and older versions through `initialize`.
- `src/tools/` holds the tools. Each one lists the roles that may call it.
- `mcpArgs` passes the server to a session with `--mcp-config`, and sets `FOREMAN_ROLE` and `FOREMAN_TASK`. `foreman up` uses it for the orchestrator, and `workerCommand` for every worker.
- The plugin has no `.mcp.json`. One would start the server in every session a marketplace install loads in, the reviewer's included.
- A session with no role gets no tools.

| Session | Tools |
|---|---|
| Worker | `report`, `propose`, `note`, `tidy` |
| Orchestrator | `plan`, `next`, `spawn`, `send`, `review`, `feedback`, `deliver`, `sync`, `teardown`, `pause`, `resume`, `restart`, `tidy`, `unblock`, `workers`, `automerge`, `set_budget`, `decisions`, `accept`, `reject`, `propose`, `adr`, `ask`, `answer`, `note`, `notes`, `shots`, `status`, `timeline`, `summary`, `cost`, `budget`, `watch`, `baseline`, `together` |
| Reviewer | none |

- A worker allows its four tools by name, like `mcp__foreman__report`, and denies `Bash(foreman *)`. Without the deny rule, auto mode could still let it run an orchestrator command.
- The orchestrator allows all its tools, so none asks for permission.
- `status`, `timeline`, `summary`, `cost` and `budget` call the same functions as their CLI commands, like `statusText`. The CLI adds colour.
- A tool that fails returns the error as its result, with `isError`. A protocol error would read as Foreman being broken.

## MCP tasks

`watch`, `baseline` and `together` can run for hours, so each returns an MCP task (D-17).

- The orchestrator ends its turn once the task starts. Claude Code checks it every 5 seconds, and its line wakes the orchestrator when it completes.
- The tab shows "MCP task still running" while it waits, then "MCP task ... completed" before the orchestrator's reply.
- A client without the tasks extension, like `claude -p`, gets the plain result. For `watch`, that call blocks until something happens.
- `tasks/cancel` aborts the handler. The session exiting closes stdin, which aborts every task.
- `watch` writes `.foreman/watch.pid` before it replies. The Stop hook reads it to block a turn that ends with tasks in flight and no watch running (D-21).
- A task can't outlive its session. After a restart the orchestrator calls `watch` again.

## Still on the CLI

- Everything people run, like `up`, `doctor`, `pane` and `status`.
- `foreman hook`, which runs Claude Code's hooks.
- The agent commands, until T32 removes them.

## Trade-offs

- A server keeps the code it started with. A fix to a tool reaches a session only after it restarts. A hook picks up a fix on its next run.
- The user's skills come from a plugin folder, not the server. Team and Enterprise logins turn off skills from MCP servers. See "The user's skills in worktree sessions" in `docs/findings.md`.
