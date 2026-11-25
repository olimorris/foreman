# ADR-0009: The user's own skills live in .foreman/skills, private to them, and shape the reviewer and the PRs Foreman opens, not the workers

## Status

Accepted

## Date

2026-11-25

## Context

The user wants their own skills, such as a code-review or pull-request skill, to shape what Foreman does.

## Decision

The user's skills live in `.foreman/skills/<name>/SKILL.md`. The reviewer checks changes against them, and a skill named `pull-request` shapes the title and description of each PR Foreman opens. Workers don't load them.

## Alternatives Considered

### The repo's `.claude/skills`

- Pros: Shared with the whole team.
- Cons: Not private, and workers already see them.
- Rejected: The user wanted them private to them.

### Workers load them too

- Pros: Standards apply while building.
- Cons: More context in every worker.
- Rejected: The user chose the reviewer and PRs only.

## Consequences

- `.foreman/` is git-ignored, so the skills are never committed.
- No skills folder means no change anywhere.
