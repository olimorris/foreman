# ADR-0007: Automerge is off until the user turns it on for a run, and it only merges Foreman's own task PRs once the reviewer approves and CI passes

## Status

Accepted

## Date

2026-11-25

## Context

The user approves every PR by default. They want to be able to tell Foreman to merge for them, so a run can finish unattended.

## Decision

Automerge is off until the user turns it on for a run with `foreman automerge on`. It only merges Foreman's own task PRs, once the reviewer approves and every CI check passes.

## Alternatives Considered

### A skill that describes when to merge

- Pros: Flexible, plain English.
- Cons: Free text can be misread.
- Rejected: Merging into main with nobody watching needs a check in code.

### Merge only low-risk PRs

- Pros: Safer.
- Cons: Most PRs would still wait.
- Rejected: The user chose any approved PR.

## Consequences

- Release PRs and the decisions PR are never merged by Foreman.
- A failing check stops the merge, and the worker is sent to fix it.
- A new plan starts with automerge off.
