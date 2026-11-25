# ADR-0001: No new task starts while the account waits for its usage limit to reset

## Status

Accepted

## Date

2026-11-25

## Context

When the account hits its usage limit, Foreman pauses every worker until the reset (ADR-0010). A task started during the wait would hit the limit at once and sit idle.

## Decision

`foreman next` and `foreman spawn` refuse to start a task while the account waits for its usage limit to reset. The check sits beside the budget check in the CLI.

## Alternatives Considered

### Hold tasks back in the plan's scheduling

- Pros: One place decides what starts.
- Cons: `foreman status` would list every waiting task with the wrong reason.
- Rejected: It misreports why tasks wait.

### Leave it to the orchestrator's prompt

- Pros: No code.
- Cons: Nothing stops a stray `foreman next`.
- Rejected: A rule that nothing enforces gets broken.

## Consequences

- A `foreman next` run by hand during the wait says why nothing started.
- Tasks start again on the first `foreman next` after the reset.
