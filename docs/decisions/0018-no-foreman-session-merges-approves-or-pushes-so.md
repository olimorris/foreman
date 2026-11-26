# ADR-0018: No Foreman session merges, approves or pushes, so only automerge merges and only deliver pushes

## Status

Accepted

## Date

2026-11-26

## Context

Automerge (ADR 7) is meant to be the only way a task PR merges without the user. Nothing stopped a worker's Bash from running `gh pr merge`, approving its own PR or pushing its branch, and the hook let every Bash call from the orchestrator through.

## Decision

The PreToolUse hook refuses `git push` in any form, `gh pr merge`, `gh pr review --approve` and `gh api` calls to a PR's merge endpoint, for the orchestrator, workers and the reviewer. It reads the command with the same quote-aware scan as the edit guard, so text that only mentions these commands, like a commit message or a report, still runs. `deliver`, the decisions PR and automerge push and merge from Foreman's own process, which the hook never sees.

## Alternatives Considered

### Block only force pushes

- Pros: A worker could still push its own branch.
- Cons: A plain push puts unreviewed code on the remote.
- Rejected: No session is told to push, since `deliver` does it.

### Match the command text with a regular expression

- Pros: Simple.
- Cons: It blocks quoted text that only mentions a command.
- Rejected: That is the bug #55 fixed in the edit guard.

## Consequences

- A session that needs to push or merge gets a message saying only automerge merges and `deliver` pushes.
- The block is best effort: a program the command runs, like a script that calls gh, isn't seen.
