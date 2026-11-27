# ADR-0022: The orchestrator opens the decisions PR without asking, so a run never stops on that question

## Status

Accepted

## Date

2026-11-26

## Context

The decide skill had the orchestrator show the user a dry-run list of the ADR files and wait for a go-ahead before opening the decisions PR. Asked whether to open it at the end of a run, the user answered "ALWAYS open decisions PR".

## Decision

The orchestrator opens the decisions PR without asking. It calls `adr` with the action `write` and no dry run once a few decisions are accepted, and always once every task in the plan has a PR or has stopped. Then it tells the user the PR link in one line. The user still decides whether to merge it.

## Alternatives Considered

### Show the dry-run list and wait for a go-ahead

- Pros: The user sees the files before a PR exists.
- Cons: Every run ends on a question with only one answer.
- Rejected: The PR itself shows the files, and nothing lands until the user merges it.

### Open it only at the end of a run

- Pros: One PR per run.
- Cons: Accepted decisions wait in the ledger longer.
- Rejected: Opening it once a few are accepted keeps the PR small.

## Consequences

- The orchestrator never asks before opening the decisions PR.
- Automerge never merges it, so the user still merges every decisions PR.
