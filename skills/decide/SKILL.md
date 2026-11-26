---
name: decide
description: Adjudicate Foreman decision proposals, record accepted decisions as the repo's ADRs, and turn PR review comments into proposals. Use when a worker proposes a decision, when PR comments arrive, or when the user wants decisions recorded.
---

# Decisions

## Set up once per repo

1. Call `adr` with the action `detect`. It reads the base branch, not the user's checkout, and saves the convention to `.foreman/config.json`: folder, numbering, title line, status field, superseded handling, README and template. Show the user the result in two lines and ask them to confirm it.
2. If it finds no ADR folder, ask the user whether to start one in `docs/decisions`. Only on a yes, call `adr` with the action `init`. The folder and its README arrive with the first decisions PR. When the user has an `adr` skill, in `.foreman/skills/adr/SKILL.md` or `~/.config/foreman/skills/adr/SKILL.md`, the new folder takes its title line and status style, and its README describes that format.
3. If the convention's README or template has writing rules, read them now. Every record you accept must follow them.
4. If the `user-skills:adr` skill is listed, load it now. It's the user's format for every record you accept. Where it disagrees with an existing ADR folder, the folder's convention wins.

## Adjudicate a proposal

A watcher line `needs-decision T1: D-4 <title>` means a worker proposed one. Read `.foreman/decisions/D-4.md`, then:

- **Already settled** (an accepted decision or ADR covers it, or the brief's intent answers it): call `reject` with a reason that points at the record, e.g. "ADR 35 already says one file per layer".
- **Only a local choice**: reject with a reason telling the worker to decide inside its own paths.
- **Cross-cutting and the user hasn't decided**: record the question with `ask`, giving the question, the `decision` D-4 and the `call` you would make, then ask the user. Put the question first, with the options in a line each, and end with what you'll do if they don't answer. Don't accept before they answer or the watcher reports `unanswered`.
- **The user agrees**: rewrite the title and body to the repo's ADR rules, then accept. With an `adr` skill, write the body in its format, with its sections in its order, and leave out the title line and status, since `adr` with the action `write` adds those. Call `accept` with the `decision` D-4, the `title` (the decision, and what it protects), the rewritten `body` as text, and the `paths` it covers, such as `src/export/**`. Add `supersedes` with the ADR numbers it reverses, and `slug` when the repo's filenames use a style the default slug won't match.

When the user answers in time, accept or reject as they said. That records their answer to Q-n on its own.

When the watcher reports `unanswered Q-n`, go ahead with your call. To accept, rewrite and accept as above, then call `answer` for Q-n with `by_foreman`. That marks the decision as decided by Foreman, and the run summary tells the user how to overrule it. If your call was to reject, reject it and record the same answer.

When the user answers after you went ahead, call `answer` for Q-n with their answer. If it disagrees with your call, overrule the decision as below.

Accepting messages the proposer and every in-flight worker whose owned paths overlap its `paths`. A decision with no paths goes to every worker. Rejecting messages only the proposer.

## Overrule a decision Foreman made

When the user overrules a decision Foreman accepted while they were away, call `reject` for D-4 with the user's reason. It messages every worker the acceptance reached, telling them to undo work that follows it. Once the decision is in the decisions PR, `reject` refuses. Propose a decision that supersedes it instead.

## Draft decisions from planning

During intake, record the user's draft decisions with `propose` (they show as proposed by `orchestrator`). Accept each one only after the user confirms it.

## PR comments that state a rule

When `pr-comments` wakes you, read the new comments. A comment that states a rule beyond this one PR ("we never block the main thread on disk I/O", "exports always keep the original audio") becomes a proposal. Propose it with a `title` stating the rule and a `body` quoting the comment and linking the PR, then ask the user to confirm it like any other. Comments about this PR only are for the worker, so pass them on with `send`.

## Record accepted decisions in the repo

Open the decisions PR without asking. When a few decisions have been accepted, and always once every task in the plan has a PR or has stopped, call `adr` with the action `write` and no `dry_run`. Then tell the user the PR link in one line. It makes one docs-only branch from the base branch, writes the records with the next free numbers, moves superseded ones the way the repo does, then pushes and opens a PR. The user's checkout isn't touched. The watcher reports when that PR gets comments or is merged. After the merge, call `adr` with the action `index`.
