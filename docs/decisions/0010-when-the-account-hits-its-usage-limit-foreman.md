# ADR-0010: When the account hits its usage limit, Foreman pauses every worker, starts nothing new and resumes after the reset

## Status

Accepted

## Date

2026-11-25

## Context

Subscription users, such as Pro, hit usage limits. A worker at its limit uses no CPU, so the watcher would read it as hung, nudge it and restart it into the same limit.

## Decision

When the account hits its usage limit, Foreman pauses every worker, starts nothing new, holds reviews and resumes everything after the reset.

## Alternatives Considered

### Treat a limited worker as hung

- Pros: No new code.
- Cons: Restarts hit the same limit and waste the wait.
- Rejected: It fights the limit instead of waiting it out.

## Consequences

- A run keeps going unattended through a limit.
- The reset time is read from Claude Code's message text, so the first real limit is the true test.
