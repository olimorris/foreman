---
name: intake
description: Turn the user's backlog and deadline into one Foreman plan they approve once. Use when the user hands over a list of work, or asks what to build first.
---

# Intake

The user gives you a backlog (a list, a file or an issue query) and usually a deadline. You turn it into one plan file. The user reads it once and approves it, and then the `next` tool runs it.

## 1. Read before planning

- Read every backlog item in full. Quote the user's own words for each one, because they become that task's Intent.
- Look at the code the items touch, enough to name the files each task changes. Don't design the solutions yet.
- Read the decisions index (`.foreman/decisions/index.md`, or call `adr` with the action `index`) and `CONTEXT.md` when there is one.
- If `.foreman/config.json` has no `test`, work out the command that runs the repo's tests from `package.json`, `Package.swift`, a `Makefile` or the CI config. It runs in a fresh checkout, so include any install step, like `bun install && bun test`. You save it in step 5.

## 2. Ask only what changes the plan

Ask a question only when the answer changes which tasks exist, what they deliver, or what gets cut. That usually means:

- An item could mean two things that would be built differently.
- The deadline can't fit everything, so something must be cut or split.
- Two items conflict.

Everything else is your call: wording, layout, naming, where a control goes, how to split the files. Make it, and list it under "Calls I made" in the plan summary, one line each, so the user can overrule it while approving. Don't ask about things a worker can settle inside its own task.

When you do have questions, ask them all in one batch, one line each, with your recommended answer. If you have none, go straight to the plan.

## 3. Shape the tasks

- One task per item a reviewer can judge on its own. Split an item when parts of it could merge separately.
- **Contracts first.** When several tasks need the same new type, API shape or schema, make that a small task of its own with `Contract: yes`. The tasks that use it list it under `Depends on`. A task with one unmerged dependency starts as soon as that dependency's PR is approved and open, on top of its branch. With two or more unmerged dependencies it waits until they merge. So keep contracts small, and give each task one dependency where you can.
- Owned paths are the smallest set each task changes. Two tasks that own overlapping paths never run at the same time. If that serialises too much, split the files or make a contract task.
- Order tasks by what the user needs first. Within the dependency order, `next` starts them in the order the plan lists them.
- When a choice affects several tasks (naming, a library, a pattern), propose it with `propose` now and mention it in the plan, so the user settles it with the plan.
- **Models.** A task with no `Model` line runs on the default: `workerModel` in `.foreman/config.json` when it's set, or Claude Code's own default. The `plan` tool prints the model each task will run on. Give a task `- Model: sonnet` when it's small and its spec leaves little to decide: a contract task, a docs-only change, or a mechanical edit such as a rename. Use `haiku` only for mechanical edits. Anything that needs judgment, and all UI work, stays on the default. If `plan` shows the default is itself a smaller model, such as sonnet or haiku, give those tasks `- Model: opus` instead. List each choice under `Calls:`, like "T3 and T5 run on sonnet: docs-only changes with a clear spec". Tasks on the default aren't listed.

## 4. Write the plan

Write `.foreman/plan.md`:

```markdown
# Plan: <short title>
Deadline: <the user's deadline, as they said it>
Calls:
- <each call you made that changes what the user sees or uses>
Cut:
- <each backlog item you cut, and why>

## T1: <PR title as a conventional commit, like "feat: add tags to notes">
- Owns: src/types.ts, src/data.ts
- Depends on: none
- Contract: yes

### Intent
<The user's words for this item. Nothing they didn't ask for.>

### Spec
<Files to start from, approach, decisions that apply, how to verify.>

### Done when
<Observable checks.>

### Screens
- <name>: <route or launch arguments>
```

Add `- Model: <name>` to a task's fields only when you chose a smaller model for it. Leave out `Calls:` or `Cut:` when there are none. Both appear again in the run summary at the end. Each task's `###` sections become its brief, so follow the dispatch skill's rules for Intent, Spec and Screens.

## 5. Check it, then start or ask

1. Call `plan` with the file `.foreman/plan.md`. It checks the plan (unknown dependencies, cycles, missing sections) and prints the waves and which tasks share paths. Fix any problem it names.
2. Show the user only what they wouldn't assume from their own backlog. The summary grows with the surprises, not with the number of tasks:
   - Tasks that don't map one-to-one to a backlog item: a split, a merge, or a contract task, with one line on why.
   - What goes first, only when the order isn't obvious or affects the deadline.
   - What you cut to meet the deadline.
   - Calls that change what the user will see or use, and which tasks run on a smaller model. Leave out calls they'd never notice.
   - Open decisions.
   - The budget, if `cost` shows a plan limit. If there's none, don't mention cost.

   Leave out the run order, which tasks share files, and anything the user would assume. A backlog that maps one-to-one, with nothing cut, needs only a few lines:

   > 6 tasks, one per item. Tags land first because the tag filter builds on them. Calls: search runs on Enter, and the footer counts all notes. Full plan in `.foreman/plan.md`. Start?
3. Decide whether the plan needs the user's approval:
   - **Start straight away** when every task maps to one backlog item, nothing is cut and there are no open decisions. Call `plan` with `approve`, then `next`, start the baseline, and arm the watcher. Then send the summary, ending with "Started. Tell me to stop or change anything." instead of "Start?".
   - **Wait for approval** when there's anything else: a split, merge or contract task, a cut, or an open decision. When they approve, run the same steps.

Start the baseline as a background command, like the watcher: `foreman baseline`, or `foreman baseline --test "<command>"` the first time, which saves the command you worked out. It runs the tests on the base branch while the workers start, and doesn't hold them up. Anything it finds reaches them as a note.

If they ask for changes, edit `plan.md` and call `plan` with its file again. That clears the approval, so ask again.

## Changing the plan later

To add or change tasks mid-flight, edit `plan.md`, call `plan` with its file again, and get the user's approval for the change. Tasks that have already started keep running. Use new ids for new work.
