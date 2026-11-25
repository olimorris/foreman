---
name: dispatch
description: Write a Foreman brief and spawn a worker for it. Use before calling Foreman's spawn tool.
---

# Dispatch a task

Work from an approved plan starts with the `next` tool, which writes each brief from the plan. Use this skill for a single task outside the plan, and for the rules every brief follows.

## 1. Write the brief

You pass the brief's text to `spawn`, which saves it as `.foreman/tasks/<id>/brief.in.md` and refuses a brief without both sections below.

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

Call `spawn` with:

- `task`: the id, such as `T1`.
- `title`: a conventional commit, such as `feat: add an export button to settings`.
- `brief`: the brief's full text, as written in step 1.
- `owns`: the owned paths, separated by spaces, such as `src/settings/** docs/settings.md`.

Add `model` set to `sonnet` for a small task whose spec leaves little to decide, such as a docs-only or mechanical change. Leave it out for anything that needs judgment or touches UI, so the worker runs on the default model. When `workerModel` in `.foreman/config.json` is a smaller model, such as sonnet or haiku, pass `opus` for that work instead. `spawn` says the model the worker started on.

Use short ids such as `T1` or `settings-pane`. The title is a conventional commit that becomes the PR title, and its first few words label the tab, such as `T1: add an export button`. Tell the user the id and that they can open the tab to watch.

## 4. Start the watch task

Call `watch` if no watch task is running already, then end your turn.
