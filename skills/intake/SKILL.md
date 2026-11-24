---
name: intake
description: Turn the user's backlog and deadline into one Foreman plan they approve once. Use when the user hands over a list of work, or asks what to build first.
---

# Intake

The user gives you a backlog (a list, a file or an issue query) and usually a deadline. You turn it into one plan file. The user reads it once and approves it, and then `foreman next` runs it.

## 1. Read before planning

- Read every backlog item in full. Quote the user's own words for each one, because they become that task's Intent.
- Look at the code the items touch, enough to name the files each task changes. Don't design the solutions yet.
- Read the decisions index (`.foreman/decisions/index.md`, or run `foreman adr index`) and `CONTEXT.md` when there is one.

## 2. Ask only what changes the plan

Ask a question only when the answer changes which tasks exist, what they deliver, or what gets cut. That usually means:

- An item could mean two things that would be built differently.
- The deadline can't fit everything, so something must be cut or split.
- Two items conflict.

Everything else is your call: wording, layout, naming, where a control goes, how to split the files. Make it, and list it under "Calls I made" in the plan summary, one line each, so the user can overrule it while approving. Don't ask about things a worker can settle inside its own task.

When you do have questions, ask them all in one batch, one line each, with your recommended answer. If you have none, go straight to the plan.

## 3. Shape the tasks

- One task per item a reviewer can judge on its own. Split an item when parts of it could merge separately.
- **Contracts first.** When several tasks need the same new type, API shape or schema, make that a small task of its own with `Contract: yes`. The tasks that use it list it under `Depends on`. A dependent task starts only after its dependency's PR merges, so keep contracts small.
- Owned paths are the smallest set each task changes. Two tasks that own overlapping paths never run at the same time. If that serialises too much, split the files or make a contract task.
- Order tasks by what the user needs first. Within the dependency order, `foreman next` starts them in the order the plan lists them.
- When a choice affects several tasks (naming, a library, a pattern), propose it with `foreman propose` now and mention it in the plan, so the user settles it with the plan.

## 4. Write the plan

Write `.foreman/plan.md`:

```markdown
# Plan: <short title>
Deadline: <the user's deadline, as they said it>

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

Each task's `###` sections become its brief, so follow the dispatch skill's rules for Intent, Spec and Screens.

## 5. Check it, then start or ask

1. Run `foreman plan .foreman/plan.md`. It checks the plan (unknown dependencies, cycles, missing sections) and prints the waves and which tasks share paths. Fix any problem it names.
2. Show the user only what they wouldn't assume from their own backlog. The summary grows with the surprises, not with the number of tasks:
   - Tasks that don't map one-to-one to a backlog item: a split, a merge, or a contract task, with one line on why.
   - What goes first, only when the order isn't obvious or affects the deadline.
   - What you cut to meet the deadline.
   - Calls that change what the user will see or use. Leave out calls they'd never notice.
   - Open decisions.
   - The budget, if `foreman cost` shows a plan limit. If there's none, don't mention cost.

   Leave out the run order, which tasks share files, and anything the user would assume. A backlog that maps one-to-one, with nothing cut, needs only a few lines:

   > 6 tasks, one per item. Tags land first because the tag filter builds on them. Calls: search runs on Enter, and the footer counts all notes. Full plan in `.foreman/plan.md`. Start?
3. Decide whether the plan needs the user's approval:
   - **Start straight away** when every task maps to one backlog item, nothing is cut and there are no open decisions. Run `foreman plan approve`, `foreman next`, and arm the watcher. Then send the summary, ending with "Started. Tell me to stop or change anything." instead of "Start?".
   - **Wait for approval** when there's anything else: a split, merge or contract task, a cut, or an open decision. When they approve, run the same three steps.

If they ask for changes, edit `plan.md` and run `foreman plan .foreman/plan.md` again. That clears the approval, so ask again.

## Changing the plan later

To add or change tasks mid-flight, edit `plan.md`, rerun `foreman plan`, and get the user's approval for the change. Tasks that have already started keep running. Use new ids for new work.
