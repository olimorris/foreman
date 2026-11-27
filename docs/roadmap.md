# Roadmap

The README promises a run that finishes while you're away, work that arrives as PRs you can try in one command, a repo that stays inside your rules and a Foreman that gets better with every run. This is the work that makes each of those promises true.

## 1. Overnight runs finish without you

Today the run stops when the orchestrator stops, and a few situations wait for you until morning.

### Keep the run going when the orchestrator exits

The watcher runs as a task inside the orchestrator's session. If that session exits, budgets, hang restarts and usage-limit resumes all stop, and nothing reopens the orchestrator.

- The status pane's process becomes a supervisor. It already runs beside the orchestrator for the whole run.
- When the orchestrator's session exits, the pane reopens it with `claude --resume` and tells it to load the recover skill.
- When tasks are in flight and no watch task has run for a few minutes, the pane wakes the orchestrator through its socket.
- The pane enforces budgets too, so they still hold while the orchestrator is down.
- Closing the pane ends this cover. A launchd agent would survive that, so it's the next step if the pane isn't enough.

### Keep the Mac awake

- Foreman holds `caffeinate -i` while a plan has tasks in flight.
- `foreman doctor` warns that closing the lid on battery still sleeps the Mac.

### Resume a worker whose session exits

- The watcher resumes an exited worker once, the same way it restarts a hung one.
- Only a second exit goes to the orchestrator.
- Resuming loses no work, so it doesn't need your say-so.

### Stop permission blocks waiting all night

- Before you approve a plan, intake lists the commands it will need, such as the test command, builds and the screenshot server. It asks you to allow them all at once.
- During the run, a block becomes a recorded question whose default call is to skip the step.
- After `answerMinutes`, the worker skips the step and its PR lists it under what still needs you.

### End every task with a PR or a reason

- When the reviewer sends work back twice and it still isn't approved, Foreman opens a draft PR labelled as not approved, with the reviewer's notes, instead of waiting for you.
- The summary gives a reason for every task that has no PR.

## 2. Reviewing the night's work faster

Today, trying a PR means switching branches, installing and starting the app by hand, every time.

### Try a PR with one command

Most of the parts already exist: worktrees, the `start` command and a port for each worktree.

- `foreman try 41` checks out the branch of PR 41 in a worktree.
- It installs the PR's dependencies and starts the app with the `install`, `start` and `url` from `screenshots` in `.foreman/config.json`.
- You can follow the worker's test steps right away, without touching your own checkout.

## 3. Rules that are actually checked

### A separate rules check for the never list

The reviewer judges whether a change meets its intent. Checking the never list is a different job, and the orchestrator shouldn't do it either.

- A separate read-only session checks each approved change against every rule in the never list.
- It answers each rule with pass or fail, and the evidence for a fail.
- Its report wakes the orchestrator, which sends a failure back to the worker or asks you when the worker can't fix it.
- `deliver` refuses to open a PR until the rules check passes, the same way it waits for the reviewer's approval.
- The PR lists each rule and its result.
- The reviewer stops checking the never list.

### Better flaky test detection

- The baseline runs the tests twice, so a test that fails one run in three is missed about half the time.
- After the two runs, the baseline reruns only the failing tests three more times.
- A PR check that fails and then passes on a rerun is noted as flaky.

## 4. Foreman gets better each run

### Learn from your edits

Foreman ships work, then you change it. Those changes show what your skills are missing.

- After you merge, Foreman compares what it shipped with what you changed before or after merging.
- It also reads what the reviewer kept sending back.
- Once a run finishes, it suggests changes to your skills, such as "you renamed three test files to the `*.spec.ts` pattern, so add that to your skill". Your skills live in `.foreman/skills` and `~/.config/foreman/skills`.
- You approve each suggestion the way you approve a decision, through the decision ledger. Nothing changes your skills until you do.

## 5. Costs that make sense

### Say what the budget measures

- Foreman detects whether the account runs on a subscription or an API key.
- On a subscription, `foreman status` and `foreman budget` show spend as a list-price estimate. The budget is a guard against a runaway task, not your bill.

### Warn before stopping

- At 80% of its budget, a worker is told to commit and report.
- The stop at 100% stays, but it no longer cuts a worker off mid-change.

### Estimate before you approve

- The plan shows each task's expected cost from its size and model.
- It warns when the total is over the plan budget.

### Review on Sonnet by default

- The reviewer runs on Sonnet unless `reviewerModel` in `.foreman/config.json` names another model. Today it falls back to Claude Code's default.
- The README's settings table says Sonnet is the default.
- Not decided yet: whether a change Sonnet rates medium or high risk, or one that touches `protect` paths, also gets a second review on Opus.

## 6. Reach

### More terminals and Linux

Foreman supports Ghostty, Orca, Herdr and Rex, all on macOS.

- A tmux integration covers Linux, iTerm, Terminal.app and any other terminal in one go.
- Linux also needs `foreman doctor`, the process checks and the screenshot adapters to work there. macOS app screenshots stay macOS only.

### GitLab

Foreman uses `gh` for every PR, check and merge. GitLab support means putting that behind an integration, the way terminals are.

## Still to verify

- Usage-limit detection matches text inferred from other API errors, because no transcript had hit a real limit. It needs testing against one.
