# ADR-0004: A PR's AI Usage line says who merges it: Foreman with automerge on, a person with it off

## Status

Accepted

## Date

2026-11-25

## Context

Every PR Foreman opens says a person merges it. With automerge on, Foreman merges it, so that line would be false.

## Decision

The PR's note on AI use says who merges it: Foreman once its checks pass when automerge is on at delivery, a person otherwise.

## Alternatives Considered

### Keep one fixed line

- Pros: No branching.
- Cons: False whenever automerge is on.
- Rejected: A PR shouldn't misstate who merges it.

## Consequences

- A PR delivered before automerge was turned on keeps the old line until it's delivered again.
