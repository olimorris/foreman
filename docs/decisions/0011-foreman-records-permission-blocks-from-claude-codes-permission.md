# ADR-0011: Foreman records permission blocks from Claude Code's permission hooks, and foreman unblock closes one

## Status

Accepted

## Date

2026-11-25

## Context

A worker, the reviewer or the orchestrator can be blocked by a permission prompt or an auto mode refusal. Claude Code reports a waiting prompt only through its PermissionRequest hook, and a refusal through its PermissionDenied hook and the transcript.

## Decision

Foreman records each block in `.foreman/blocks.json` from those hooks and tells the user, with the allow rule to add. `foreman unblock <task>` closes a block once the user has allowed the call or said to skip it.

## Alternatives Considered

### A second hook entry point outside the CLI

- Pros: Smaller CLI.
- Cons: Hook handling splits across two files.
- Rejected: One dispatcher is easier to follow.

### Close a block when the same call later succeeds

- Pros: Automatic.
- Cons: A skipped call never succeeds.
- Rejected: The task would show as needing the user forever.

## Consequences

- A blocked worker isn't nudged or restarted as hung.
- The user sees one line per block, naming the rule to add.
