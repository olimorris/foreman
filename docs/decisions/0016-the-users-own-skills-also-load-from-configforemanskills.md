# ADR-0016: The user's own skills also load from ~/.config/foreman/skills, and a repo's skill of the same name wins, so skills used in every repo live in one place

## Status

Accepted

## Context

The user's own skills load from `.foreman/skills` in the orchestrator, every worker and the reviewer (D-14). The user wants skills they use in every repo, such as pull-request or adr, in one place instead of a copy in each repo's `.foreman/skills`.

## Decision

The user's skills also load from `~/.config/foreman/skills`, or `$XDG_CONFIG_HOME/foreman/skills` when that's set, in the orchestrator, every worker and the reviewer. When the repo and the global folder both have a skill of the same name, the repo's wins. The pull-request and adr skills Foreman looks up by name follow the same rule.

The user-skills plugin's `skills` folder holds one link per skill, pointing at the repo's or the global copy, and Foreman rebuilds the links when each session starts. Skills still never enter a worktree or git.

## Alternatives Considered

### Two plugin folders, one per source

- Pros: No links to rebuild.
- Cons: Both need the user-skills name, and nothing says which copy wins.
- Rejected: The repo's skill has to win reliably.

### Copying the global skills into .foreman/skills

- Pros: Nothing changes in how skills load.
- Cons: Copies go stale and mix the user's global files into a repo folder.
- Rejected: The global folder has to stay the one place the user edits.

### A global folder under ~/.claude

- Pros: Claude Code already reads it.
- Cons: Claude Code would load those skills in every session, not just Foreman's.
- Rejected: The skills are for Foreman's sessions only.

## Consequences

- A skill edited in the global folder reaches every repo's next session.
- A repo can override a global skill by adding one of the same name to `.foreman/skills`.
- The reviewer needs read access to every folder that holds a skill, not just `.foreman/skills`.
