# ADR-0005: Terminal integrations live in their own folder under src/integrations, and Foreman finds them by folder

## Status

Accepted

## Date

2026-11-25

## Context

Foreman started with Rex as its only terminal, listed by hand in `src/integrations/index.ts`. Ghostty, Orca and Herdr were to be built at the same time.

## Decision

Each terminal integration lives in its own folder under `src/integrations/`, and Foreman finds them by folder. Each folder's README holds that terminal's setup and what was learned about driving it.

## Alternatives Considered

### A hand-kept list of terminals

- Pros: Explicit.
- Cons: Every new terminal edits the same file.
- Rejected: No two terminals could be built at once.

## Consequences

- Adding a terminal never edits a shared file.
- `foreman doctor` lists the terminals it finds.
