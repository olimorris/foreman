# ADR-0008: The user's rules for what Foreman must never do live in the never list in .foreman/config.json and reach the orchestrator, every brief and the reviewer

## Status

Accepted

## Date

2026-11-25

## Context

The user needs to tell Foreman things it must never do, such as merging a release PR, and have every session follow them.

## Decision

The rules live in the `never` list in `.foreman/config.json`. The orchestrator gets them at session start, and every brief and the reviewer's prompt list them.

## Alternatives Considered

### Notes (`foreman note`)

- Pros: Already reach every worker.
- Cons: Notes record facts about the setup, not rules.
- Rejected: Wrong kind of record.

### A hook that blocks commands

- Pros: Can't be talked around.
- Cons: Can't check plain-English rules.
- Rejected: Left as follow-up for rules that can be checked mechanically.

## Consequences

- A rule written once holds for every session in the run, including after a restart.
- The rules are followed by judgment, so a rule that matters most still wants a hook.
