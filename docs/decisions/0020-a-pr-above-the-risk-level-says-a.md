# ADR-0020: A PR above the risk level says a person merges it, so the PR never misstates who merges it

## Status

Accepted

## Date

2026-11-26

## Context

ADR 4 says a PR's AI Usage line names who merges it. Under the risk limit, a PR rated above `automerge.maxRisk` never merges automatically, but the line still said Foreman merges it whenever automerge was on. With the default of low, every medium and high risk PR misstated who merges it.

## Decision

A PR's AI Usage line says Foreman merges it only when automerge is on at delivery and the delivered verdict's risk is at or below `automerge.maxRisk`. Otherwise it says a person merges it.

## Alternatives Considered

### Say "Foreman may merge it"

- Pros: No extra check at delivery.
- Cons: Vague, and still wrong for a PR that will never merge automatically.
- Rejected: A PR shouldn't misstate who merges it.

## Consequences

- If the user raises `maxRisk` after delivery, the line stays as it was until the PR is delivered again.
