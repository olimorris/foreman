<p align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/foreman-banner-dark.png">
        <img alt="Foreman" src="assets/foreman-banner-light.png">
    </picture>
</p>

## :firecracker: Problem Statement

Building and deploying software takes a team of engineers. Those engineers need a manager to coordinate and review their work. That manager needs a leader to set the vision. That leader is you.

Foreman gives you the team and the manager, right inside Claude Code.

> [!IMPORTANT]
> Foreman runs inside [Rex](https://www.superlogical.com), a terminal app. Each worker gets its own Rex tab, so you can watch any of them or step in. Rex is the only terminal Foreman supports today, and others can be added as integrations in `src/integrations/`.

## :construction_worker: What is Foreman?

Foreman is a Claude Code plugin that turns one Claude session into the manager of a small engineering team.

You talk to Foreman. Foreman runs the crew:

- **The engineers** are worker Claude sessions. Each one is numbered W1, W2 and so on, and gets its own git worktree and Rex tab, so they can work in parallel without stepping on each other - and you can open any of them to watch or steer.
- **The manager** is Foreman. It never writes code itself. It plans, hands out work, keeps everyone aligned, and checks the work before it reaches you.
- **The leader** is you. You set the direction and approve every PR. Nothing merges without your say-so.

### How it works

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.svg">
        <img alt="How Foreman works: you hand over a backlog, Foreman briefs workers, a reviewer checks their work, approved work becomes a PR you merge, and merging starts the next tasks" src="assets/how-it-works-light.svg">
    </picture>
</p>

1. **Give it a backlog.** Tell Foreman what you want done and by when. It talks the intent through with you, then turns each item into a brief with clear boundaries.
2. **It schedules the crew.** Foreman decides what can run in parallel and what has to go first, based on dependencies and your deadline.
3. **Decisions are shared.** Foreman reads your repo's existing ADRs (`docs/decisions`, `docs/adr` and friends) and keeps every worker on the same page. Workers propose new decisions; Foreman accepts them and tells the rest of the crew, so conflicts surface early instead of at merge time.
4. **Work gets reviewed.** A separate reviewer checks each change against your intent. For UI work it takes screenshots and sends specific feedback back to the worker until it's right.
5. **You approve the PR.** Every PR arrives as a review packet: what was asked, what decisions were touched, before/after screenshots, and a risk summary.

### What Foreman isn't

It's Claude Code only and works on one repo at a time. That's deliberate - fewer moving parts, less to break.

## :package: Install

Foreman runs on macOS inside [Rex](https://www.superlogical.com). You need:

- Claude Code 2.1.224 or later
- [Bun](https://bun.sh), `git`, `jq`, `fswatch` and `gh` (signed in with `gh auth login`)
- For web screenshots: Playwright's Chromium (`bunx playwright install chromium`)
- For macOS app screenshots: Xcode, and Screen Recording permission for your terminal in System Settings > Privacy & Security > Screen & System Audio Recording

```sh
brew install jq fswatch gh
git clone https://github.com/olimorris/foreman ~/Code/Foreman
cd ~/Code/Foreman && bun install
ln -s ~/Code/Foreman/bin/foreman ~/.local/bin/foreman
foreman doctor
```

`foreman doctor` checks every requirement and says what's missing.

## :rocket: Usage

Open Rex in your repo and start Foreman:

```sh
foreman up
```

This opens a `foreman-<repo>` session with the orchestrator in it, and the status pane beside it. Give it your backlog and deadline in plain words, or point it at a file:

> Here's my backlog: BACKLOG.md. Deadline is Friday.

From there:

1. Foreman asks about anything unclear, then shows you one plan: tasks, what runs first, and what it would cut to meet the deadline. Approve it or ask for changes.
2. Workers open in their own tabs, named like `W1 · T1: add tags to notes`: the worker, then the task it's building. Open one to watch or steer it.
3. When a worker proposes a decision that affects others, Foreman asks you before accepting it.
4. Each finished task gets a review. Approved work arrives as a PR with its review packet. You merge it.
5. When a PR merges, Foreman tears down that task, asks the remaining workers to rebase and starts the tasks that were waiting on it.
6. When the run is done, Foreman writes `.foreman/summary.md`: the PRs in the order to review them, how to test each one, and the assumptions the workers made that you should check. Run `foreman summary` to get one mid-run.

All state lives in `.foreman/` in your repo, which Foreman keeps out of git. If the orchestrator restarts, it picks up from there.

### Status pane

The status pane sits to the right of the orchestrator and shows the run at a glance. It redraws every couple of seconds:

- **Needs you**: tasks waiting on a decision, blocked, stopped or with a closed worker, with the question or reason underneath
- **Working**: each worker's task, what it's doing right now, such as the command it's running or the file it's editing, and for how long
- **Ready to merge**: PRs waiting for you, with the reviewer's risk
- **Waiting**: planned tasks and what they wait on
- **Recent**: the last few things that happened

A worker that's been quiet for half the stall time turns yellow, and red once it reaches it. If you close the pane, `foreman pane` opens it again beside the tab you run it from.

### Screenshots

Foreman takes before and after screenshots of the screens a task changes. Set it up once per repo in `.foreman/config.json`. For a web app:

```json
{ "screenshots": { "adapter": "web", "start": "npm run dev -- --port {port}", "url": "http://localhost:{port}" } }
```

For a macOS app:

```json
{ "screenshots": { "adapter": "macos", "build": "xcodebuild -scheme App -derivedDataPath {derivedData} build", "app": "{derivedData}/Build/Products/Debug/App.app" } }
```

Each copy of a macOS app runs with its own bundle id and home folder, so screenshots never touch your real app's data.

### Budget

Foreman keeps an eye on what the crew costs. Every task has a limit, and so does the plan as a whole:

- **$5 per task**, covering the worker and its reviews
- **$40 per plan**, covering every task plus Foreman itself

These are hard limits. Foreman checks spend at least every 30 seconds while the watcher runs. When a task goes over, Foreman closes its worker's tab, which ends the session, and asks whether to raise the limit. When the plan goes over, it stops every worker that's running and starts no new tasks. A reviewer is never allowed to spend more than its task has left.

Committed work stays on the task's branch, and anything uncommitted stays in its worktree. Once you raise the limit, `foreman resume` reopens the worker's session where it left off.

```sh
foreman budget            # what each task has spent against its limit
foreman cost              # the same spend, split into workers and reviews
foreman budget 10         # $10 per task
foreman budget --plan 80  # $80 for the plan
foreman budget T3 15      # $15 for one task
foreman resume T3         # restart a stopped worker once its limit is raised
```

Costs are worked out at Anthropic's list prices from each session's token use, so on a subscription treat them as a guide to how much work was done. Each PR's AI Usage section includes its task's cost.

### Stuck workers

A worker that waits on a hung command, such as a test run that deadlocks, can sit idle for hours. Any task that shares its files can't start until it finishes. Foreman watches for this:

- After 20 minutes with no reply, Foreman messages the worker to check for a hung command.
- After 40 minutes, Foreman restarts the worker's session in a new tab.
- If a worker hangs again after two restarts, the orchestrator steps in.

`foreman restart T3` restarts a worker by hand.

### Settings

`.foreman/config.json` also takes:

- `maxWorkers`: how many workers run at once (default 3)
- `stallMinutes`: how long a worker can go without replying before Foreman nudges it (default 20)
- `prScreenshots`: `"local"` keeps screenshots on your machine and lists their paths in the PR. `"branch"` pushes them to a `foreman-screenshots` branch so they show in the PR on GitHub
