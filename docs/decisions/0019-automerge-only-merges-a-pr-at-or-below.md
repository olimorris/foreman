# ADR-0019: Automerge only merges a PR at or below the repo's risk level, so risky changes wait for the user

## Status

Accepted

## Date

2026-11-26

## Context

The reviewer rates every PR's risk as low, medium or high, but automerge ignored it, so a high risk PR merged unattended once its checks passed. ADR 7 turned down merging only low-risk PRs when automerge first shipped. The user has since asked for a risk limit, so this narrows ADR 7 without reversing it.

## Decision

Automerge only merges a task PR whose latest verdict's risk is at or below `"automerge": { "maxRisk": "low" }` in .foreman/config.json. The default is low. A riskier PR stays with the user, shows under "Ready to merge" in status and the pane, and the watcher sends one too-risky line per PR so the orchestrator can say why. A verdict without a risk counts as medium. A level Foreman doesn't recognise counts as low, so a typo never loosens it. The risk check runs after the checks, so a failing check still goes back to the worker first.

## Alternatives Considered

### Default to high

- Pros: Keeps automerge's behaviour from before.
- Cons: Risky PRs still merge with nobody watching.
- Rejected: The safe default is the one the user asked for.

### Store the level on the plan, like the automerge switch

- Pros: Each run could choose its own level.
- Cons: The user would set it again for every plan.
- Rejected: It's the user's tolerance for the repo, which doesn't change per plan.

## Consequences

- With the default, a medium or high risk PR always waits for the user.
- The setting is listed in `foreman automerge on`.
