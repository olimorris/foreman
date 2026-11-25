# ADR-0012: Workers and the orchestrator load the user's own skills from .foreman/skills, as well as the reviewer

## Status

Accepted

## Date

2026-11-25

## Context

ADR 9 kept the user's own skills in `.foreman/skills` from workers, so they shaped only the review and the PRs Foreman opens. A worker built without them and found out it broke one only when the reviewer sent the work back. The orchestrator didn't load them either, so it couldn't follow a skill like `pull-request` itself.

## Decision

Every worker and the orchestrator load the user's skills from `.foreman/skills`, as well as the reviewer. The skills stay private to the user in `.foreman/`, out of git, and are never copied into a worktree.

## Alternatives Considered

### Reviewer and PRs only (ADR 9)

- Pros: Less context in every worker.
- Cons: Workers learn a skill's rules only from review feedback, which costs a revision round.
- Rejected: The user wants workers to build by their skills.

### Copy the skills into each worktree's `.claude/skills`

- Pros: Works with any Claude Code version.
- Cons: Puts the user's private files in a checkout a worker commits from.
- Rejected: A worker could commit them.

## Consequences

- Skills load on demand, so a skill that doesn't fit the task costs only its description.
- Foreman needs a way to hand the skills to sessions whose working directory is a worktree, which the task that builds this settles and records in `docs/spikes.md`.
