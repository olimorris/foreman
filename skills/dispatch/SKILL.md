---
name: dispatch
description: Write a Foreman brief and spawn a worker for it. Use before running foreman spawn.
---

# Dispatch a task

Work from an approved plan starts with `foreman next`, which writes each brief from the plan. Use this skill for a single task outside the plan, and for the rules every brief follows.

## 1. Write the brief

Write it to `.foreman/tasks/<id>/brief.in.md`. `foreman spawn` refuses a brief without both sections below.

```markdown
## Intent

<The user's ask in their own words, plus only the context needed to read it.
No "you", no speaker labels. The reviewer treats this section as acceptance
criteria, so never add scope the user didn't ask for.>

## Spec

<How to build it: files to start from, approach, constraints, decisions that
apply, how to verify. Reference screens or routes by name.>

## Done when

<Observable checks: tests that pass, behaviour to see.>

## Screens

- <name>: <web route, or macOS launch arguments>
```

Add `## Screens` only for UI changes. The reviewer compares before and after screenshots of each screen listed.

## 2. Choose owned paths

- List the smallest set of paths or globs the task must change, such as `src/settings/**` or `docs/settings.md`.
- No two running tasks may own the same path. Shared contracts (types, interfaces) get their own task, which lands first.
- A path ending in `/` means everything under it.

## 3. Spawn

```sh
foreman spawn <id> --title "feat: add an export button to settings" --brief .foreman/tasks/<id>/brief.in.md --owns 'src/settings/**' --owns docs/settings.md
```

Use short ids such as `T1` or `settings-pane`. The title is a conventional commit that becomes the PR title, and its first few words label the tab, such as `T1: add an export button`. Tell the user the id and that they can open the tab to watch.

## 4. Arm the watcher

Start `foreman watch` in the background if it isn't armed already, then end your turn.
