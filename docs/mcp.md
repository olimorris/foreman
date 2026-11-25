# Foreman's MCP server

The `foreman` CLI is for people. Foreman's MCP server, started by `foreman mcp`, is for the orchestrator and workers. Decision D-16 records the split, and D-17 and D-21 cover the tools that run as MCP tasks. They reach `docs/decisions/` in the next decisions PR. This note says what was built and why. `docs/spikes.md` has what was checked against Claude Code on the way.

## Why agents moved off the CLI

The orchestrator and workers used to run `foreman` commands through the Bash tool, the same CLI people use.

- A message, a decision body or a test step with quotes, backticks or `$` had to go through `--body-file` to survive the shell. A tool takes it as a JSON string.
- Every session got a `Bash(foreman *)` allow rule, so a worker could run `foreman accept` on its own proposal. A tool is offered only to the role that uses it.
- `foreman help` listed about 30 commands people never run.

An earlier version of this note recommended against a server, because every command would then need two front doors kept in step. D-16 avoids that by giving each command one home: agent commands leave the CLI, and commands both need share one implementation.

## What was built

- `src/mcp.ts` is a stdio JSON-RPC server with no SDK. It speaks protocol 2026-07-28 through `server/discover`, and the older versions through `initialize`.
- `src/tools/` holds the tools, each with the roles that may call it: `worker.ts`, `orchestrator.ts`, `overview.ts` for the commands people use too, and `tasks.ts` for the MCP tasks.
- `mcpArgs` in `src/mcp.ts` passes the server to a session with `--mcp-config`, with `FOREMAN_ROLE` and `FOREMAN_TASK` in its environment. `foreman up` passes it to the orchestrator, and `workerCommand` in `src/spawn.ts` to every worker it starts, resumes or restarts.
- The plugin has no `.mcp.json`. One would start the server in every session a marketplace install loads in, the reviewer's included.
- `toolsFor` offers each session only its role's tools. A session without a role gets none.

| Session | Tools |
|---|---|
| Worker | `report`, `propose`, `note`, `tidy` |
| Orchestrator | `plan`, `next`, `spawn`, `send`, `review`, `feedback`, `deliver`, `sync`, `teardown`, `pause`, `resume`, `restart`, `tidy`, `unblock`, `workers`, `automerge`, `set_budget`, `decisions`, `accept`, `reject`, `propose`, `adr`, `ask`, `answer`, `note`, `notes`, `shots`, then `status`, `timeline`, `summary`, `cost`, `budget`, and the tasks `watch`, `baseline`, `together` |
| Reviewer | none, since it's a `claude -p` run limited to Read, Grep and Glob |

- A worker's `--allowedTools` lists its four tools by name, like `mcp__foreman__report`, and its `--disallowedTools` denies `Bash(foreman *)`. Without the deny rule, auto mode's classifier could still let a worker run an orchestrator command.
- The orchestrator's `--allowedTools` lists all of its tools, so none of them asks for permission.
- `status`, `timeline`, `summary`, `cost` and `budget` call the same functions as their CLI commands, such as `statusText` in `src/status.ts`. The CLI prints them with colour, and the tools return plain text.
- A tool that fails returns its error as the tool's result with `isError`, so the agent reads why. A protocol error would read as Foreman being broken.

## MCP tasks

`watch`, `baseline` and `together` can run for hours. They used to be background commands that woke the orchestrator through its messaging socket. Now each returns an MCP task (D-17).

- A call from a client that offers the `io.modelcontextprotocol/tasks` extension gets a task straight away, and the orchestrator ends its turn. Claude Code checks the task with `tasks/get` every 5 seconds. When it completes, its one line wakes the orchestrator, even when it's idle.
- In the orchestrator's tab, the user sees "1 MCP task still running" next to the turn's time while it waits, then a line like `⏺ MCP task watch-… (foreman/watch) completed.` before the orchestrator's reply.
- A client that doesn't offer the extension, such as `claude -p`, gets the plain result once the handler finishes. For `watch`, that's a call that blocks until something happens.
- `tasks/cancel` aborts the handler. Closing stdin, which happens when the session exits, aborts every running task.
- The watch tool writes `.foreman/watch.pid` with the server's pid before it replies. The Stop hook reads it and blocks the orchestrator from ending a turn while tasks are in flight and no watch task is running (D-21).
- A task can't outlive its session, because the server stops with it. After a restart the orchestrator calls `watch` again.

## What's still on the CLI

- Everything people run: `up`, `doctor`, `pane`, `status`, `budget` and the rest of `foreman help`.
- `foreman hook`, which `hooks/hooks.json` runs for Claude Code's hooks.
- `foreman mcp` itself.
- For now, the agent commands too. T32 removes them from the CLI and updates the README's list of commands.

## What stays the same

- A server keeps the code it started with until its session restarts. A fix to a tool reaches a running orchestrator or worker only after it restarts, while a hook picks up the fix on its next run.
- The user's own skills reach sessions through a second `--plugin-dir`, not the server. Team and Enterprise logins ignore an MCP server's skills unless an admin turns them on. See "The user's skills in worktree sessions" in `docs/spikes.md`.
