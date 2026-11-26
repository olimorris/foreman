# ADR-0014: The watcher, the baseline and the together check run as MCP tasks on Foreman's server, not as CLI commands

## Status

Accepted

## Date

2026-11-25

## Context

The orchestrator starts `foreman watch`, `foreman baseline` and `foreman together` as background commands that wake it through a socket, and a Stop hook blocks it when the watcher isn't armed. People never need these commands. Claude Code supports MCP tasks: a tool call can return a task, the turn carries on, and the result reaches Claude when the task completes.

## Decision

`watch`, `baseline` and `together` become orchestrator tools on Foreman's MCP server that return MCP tasks and complete with the line they send today. They leave the CLI. The task that builds this first checks that a completing task wakes an idle session in auto mode and that a long wait survives over stdio, and if not, proposes a decision that supersedes this one.

## Alternatives Considered

### Keep the background commands and the socket

- Pros: Already works.
- Cons: The orchestrator re-arms the watcher after every event, and the Stop hook has to police it.
- Rejected: The user doesn't need the watcher as a command, and MCP tasks fit.

### Push events into the session through a Claude Code channel

- Pros: Wakes the session without a pending tool call.
- Cons: Channels are a research preview, and the user's organisation blocks them.
- Rejected: Not available to the user.

## Consequences

- The orchestrator no longer arms a watcher, and the Stop hook loses its watcher check.
- `claude -p` gets no MCP tasks, which doesn't matter because only the orchestrator, an interactive session, uses them.
