---
name: decide
description: Adjudicate Foreman decision proposals, record accepted decisions as the repo's ADRs, and turn PR review comments into proposals. Use when a worker proposes a decision, when PR comments arrive, or when the user wants decisions recorded.
---

# Decisions

## Set up once per repo

1. Run `foreman adr detect`. It reads the base branch, not the user's checkout, and saves the convention to `.foreman/config.json`: folder, numbering, title line, status field, superseded handling, README and template. Show the user the result in two lines and ask them to confirm it.
2. If it finds no ADR folder, ask the user whether to start one in `docs/decisions`. Only on a yes, run `foreman adr init`. The folder and its README arrive with the first decisions PR.
3. If the convention's README or template has writing rules, read them now. Every record you accept must follow them.

## Adjudicate a proposal

A watcher line `needs-decision T1: D-4 <title>` means a worker proposed one. Read `.foreman/decisions/D-4.md`, then:

- **Already settled** (an accepted decision or ADR covers it, or the brief's intent answers it): reject with a reason that points at the record, e.g. `foreman reject D-4 --reason "ADR 35 already says one file per layer"`.
- **Only a local choice**: reject with a reason telling the worker to decide inside its own paths.
- **Cross-cutting and the user hasn't decided**: ask the user. Put the question first, with the options in a line each. Don't accept on your own.
- **The user agrees**: rewrite the title and body to the repo's ADR rules, then accept:
  `foreman accept D-4 --title "<decision, and what it protects>" --body-file .foreman/decisions/D-4.final.md --paths 'src/export/**'`
  Add `--supersedes <n>` when it reverses an existing ADR, and `--slug` when the repo's filenames use a style the default slug won't match.

Accepting messages the proposer and every in-flight worker whose owned paths overlap `--paths`. A decision with no paths goes to every worker. Rejecting messages only the proposer.

## Draft decisions from planning

During intake, record the user's draft decisions with `foreman propose` (they show as proposed by `orchestrator`). Accept each one only after the user confirms it.

## PR comments that state a rule

When `pr-comments` wakes you, read the new comments. A comment that states a rule beyond this one PR ("we never block the main thread on disk I/O", "exports always keep the original audio") becomes a proposal. Propose it with `--body` quoting the comment and linking the PR, then ask the user to confirm it like any other. Comments about this PR only are for the worker, so pass them on with `foreman send`.

## Record accepted decisions in the repo

When a few decisions are accepted, or before the user's merge session, run `foreman adr write --dry-run` and show the user the file list. On their go-ahead, run `foreman adr write`. It makes one docs-only branch from the base branch, writes the records with the next free numbers, moves superseded ones the way the repo does, then pushes and opens a PR. The user's checkout isn't touched. The watcher reports when that PR gets comments or is merged. After the merge, run `foreman adr index`.
