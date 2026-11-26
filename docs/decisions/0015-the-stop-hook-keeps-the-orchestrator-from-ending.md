# ADR-0015: The Stop hook keeps the orchestrator from ending a turn with tasks in flight and no watch task running

## Status

Accepted

## Date

2026-11-25

## Context

D-17 moves the watcher to an MCP task and says the Stop hook loses its watcher check. But the watch task completes after every event, and the orchestrator has to call `watch` again once it has handled the line. If it forgets once, nothing wakes it and the run stalls until the user notices.

## Decision

The Stop hook still blocks the orchestrator from ending a turn while tasks are in flight and no watch task is running, and its message tells it to call the `watch` tool. The watch tool writes `.foreman/watch.pid` with the server's pid before it replies, so the hook sees the task the moment the turn ends.

## Alternatives Considered

### Drop the check, as D-17 said

- Pros: One less hook.
- Cons: Nothing catches a forgotten `watch` call.
- Rejected: It removes the only guard against a stalled run.

## Consequences

- This replaces D-17's line that the Stop hook loses its watcher check. The rest of D-17 stands.
