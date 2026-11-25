# Contributing to Foreman

Foreman is a Claude Code plugin written in TypeScript on Bun. There's no build step, because `bin/foreman` runs `src/cli.ts` directly. [AGENTS.md](AGENTS.md) holds the working rules for agents and people alike, and this guide expands on them.

## Set up

You need [Bun](https://bun.sh), git and the [GitHub CLI](https://cli.github.com/) signed in with `gh auth login`. Then clone the repo and install:

```sh
git clone https://github.com/olimorris/foreman.git
cd foreman
bun install
```

## Work in a worktree

Don't edit the checkout itself. Live Foreman runs load the plugin from it with `--plugin-dir`, so an edit there changes running orchestrators and workers at once.

Make a git worktree outside the checkout and work there:

```sh
git worktree add ../foreman-my-change -b my-change
cd ../foreman-my-change
bun install
```

Worktrees share one stash list, so stash in one worktree at a time.

## Try your change

`foreman` on your PATH runs the clone at `~/.local/share/foreman`, not your worktree. To run your own code, use `bun src/cli.ts` from the worktree, against a scratch repo outside this folder:

```sh
mkdir /tmp/scratch && cd /tmp/scratch && git init
bun /path/to/foreman-my-change/src/cli.ts doctor
```

Replace `/path/to/foreman-my-change` with your worktree. Any `foreman` command works the same way, such as `status` or `up`.

## Run the checks

```sh
bun test
bun run typecheck
```

These two are the gate. GitHub Actions fails every job on a billing error for now, so CI tells you nothing.

### Writing tests

Tests drive pure functions. They never open real terminal tabs or start `claude` sessions. `test/helpers.ts` has what you need:

- `tempRepo()` makes a throwaway git repo with one commit and returns it.
- `fakeTerminal()` stands in for a terminal. It records what was sent, closed and labelled, so a test can check it afterwards.

Code the watcher calls takes its outside world as probes, like `scan` in `src/watch.ts`. Follow that shape so a test can pass in fakes.

## Record what you learn

When you find out how Claude Code, Rex, git or `gh` behave, write it in [docs/spikes.md](docs/spikes.md). One short bullet per finding is enough.

A change to what the orchestrator, a worker or the reviewer should do updates `agents/`, `skills/` or `prompts/` in the same PR. The [README](README.md) covers anything a user sees.

Every new line in a task's `events.jsonl` wakes the orchestrator. Log Foreman's own steps with `logRun` instead.

## Keep `~/.local/share/foreman` current

Run this once in your checkout:

```sh
git config core.hooksPath scripts/git-hooks
```

After that, every `git pull` here that brings in new commits also fast-forwards `~/.local/share/foreman` to `origin/main`. It prints one line when it can't, such as when that clone isn't on `main`. A pull that says "Already up to date" runs no hooks, so it leaves the clone alone.

## Commits and pull requests

A commit is one line in conventional form, like `feat: write a run summary of the PRs to review`, with no body and no trailers. A PR has a Summary, a Why and a How to test. [.claude/skills/pull-request](.claude/skills/pull-request/SKILL.md) has the full format and an example.

## Releases

You don't cut releases. [release-please](release-please-config.json) opens a `chore(main): release ...` PR on `main` from the conventional commits, and the maintainer merges it. Never edit the version in `.claude-plugin/plugin.json` or `.release-please-manifest.json` by hand.
