# ADR-0013: People use the foreman CLI and agents use Foreman's MCP server, and commands both need live in one place that each calls

## Status

Accepted

## Date

2026-11-25

## Context

The orchestrator and workers drive Foreman by running the `foreman` CLI through the Bash tool, the same CLI people use. Bodies with quotes, backticks or `$` need `--body-file` to survive the shell, a `Bash(foreman *)` rule lets a worker run orchestrator commands such as `foreman accept`, and `foreman help` lists commands people never run. `docs/mcp.md` weighed putting every command in both places and found the cost was keeping two front doors in step.

## Decision

The CLI is for people and the MCP server, started by `foreman mcp`, is for agents. Each agent command becomes a tool on the server, offered only to the roles that use it, and leaves the CLI. Commands both need, such as `status`, `timeline`, `summary`, `cost` and `budget`, live in one shared module that the CLI and the server both call.

## Alternatives Considered

### Every command in both the CLI and the server

- Pros: Nothing to move, and agents could fall back to the CLI.
- Cons: Two front doors to keep the same in arguments, errors, output and tests.
- Rejected: The user wants the two kept apart.

### Keep the CLI for agents and narrow the Bash rules

- Pros: No server.
- Cons: Shell quoting stays, and `foreman help` stays full of agent commands.
- Rejected: It fixes only the permissions.

## Consequences

- The server runs only in sessions Foreman starts, because Foreman passes it with `--mcp-config`.
- Every agent, skill and prompt file that names a `foreman` command is rewritten to call the tool.
- The reviewer, a `claude -p` run, calls no Foreman commands, so nothing changes for it.
