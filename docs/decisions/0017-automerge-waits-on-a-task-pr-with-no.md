# ADR-0017: Automerge waits on a task PR with no checks unless the repo opts in, so unchecked code never merges unattended

## Status

Accepted

## Date

2026-11-26

## Context

ADR 7 lets automerge merge a task PR once the reviewer approves and every check passes. An empty check list counted as every check passing, so a repo with no CI, or one whose checks hadn't registered yet, merged code that nothing had checked.

## Decision

With automerge on, a task PR with no checks waits. The watcher sends one no-checks line per PR, and the orchestrator tells the user the PR stays with them. A repo with no CI opts in with `"automerge": { "allowNoChecks": true }` in .foreman/config.json, which lasts across plans.

## Alternatives Considered

### Treat no checks as passing

- Pros: Repos with no CI merge without any setup.
- Cons: Code nothing checked reaches main with nobody watching.
- Rejected: That is the behaviour this decision fixes.

### Warn again for each new head commit, like check-failed

- Pros: The user hears about every push.
- Cons: Every push to a repo with no CI repeats the same message.
- Rejected: Once per PR is enough to say why it waits.

## Consequences

- Repos with no CI need the setting before automerge merges anything.
- If checks appear on the PR later, it merges as usual once they pass.
