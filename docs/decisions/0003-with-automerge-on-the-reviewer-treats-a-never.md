# ADR-0003: With automerge on, the reviewer treats a never rule about merging that a PR falls under as an issue

## Status

Accepted

## Date

2026-11-25

## Context

Automerge only touches `foreman/<id>` branches, which keeps release PRs out. A never rule such as "never merge a PR that changes a migration" would otherwise go unchecked, because the reviewer checks whether a change breaks a rule, not whether merging it would.

## Decision

With automerge on, the reviewer's prompt says that approving means Foreman merges the PR once its checks pass, so a never rule about merging that the PR falls under is an issue.

## Alternatives Considered

### Parse the never rules in code

- Pros: Enforced without a model.
- Cons: The rules are free text.
- Rejected: Unreliable.

### Refuse automerge when any rule mentions merging

- Pros: Simple and safe.
- Cons: The release-PR rule alone would block it, though automerge never touches release PRs.
- Rejected: It would make automerge unusable.

## Consequences

- A never rule about merging holds a PR back through the reviewer.
- The reviewer's judgment, not code, applies these rules.
