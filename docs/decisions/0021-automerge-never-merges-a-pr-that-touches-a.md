# ADR-0021: Automerge never merges a PR that touches a protected path, so those changes always wait for the user

## Status

Accepted

## Date

2026-11-26

## Context

Some paths, like migrations or CI workflows, should never reach main without a person looking, however the reviewer rates the PR. ADR 3 has the reviewer judge the user's never rules, but a model can miss a file, and this needs to be certain.

## Decision

The user lists globs under `"protect"` in .foreman/config.json, with no default. Before merging, the watcher lists the PR's changed files against `origin/<base>` and matches them with the same glob logic as owned paths. Any match keeps the PR with the user, and the watcher sends one protected line per PR naming the matched paths. If the files can't be listed while `protect` is set, the PR waits too. Workers can still edit protected paths, every brief lists them, and the PR's AI Usage line says a person merges it. The reviewer's never-rule check from ADR 3 stays.

## Alternatives Considered

### Block worker edits to protected paths

- Pros: Protected files never change at all.
- Cons: Work the user wants done couldn't be built.
- Rejected: Only the merge needs holding.

### Leave it to the reviewer

- Pros: No new setting.
- Cons: A model can miss a file.
- Rejected: This needs a check in code.

## Consequences

- A git failure while listing files holds the PR rather than merging it.
- A PR that touches a protected path always waits for the user, whatever its risk.
