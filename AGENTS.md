# AGENTS.md

Foreman is a Claude Code plugin: one orchestrator session runs worker sessions in git worktrees and Rex tabs. TypeScript on Bun with no build step, since `bin/foreman` runs `src/cli.ts`.

## Where to work

- Make changes in a git worktree outside this folder. Live Foreman runs load the plugin from this checkout with `--plugin-dir`, so an edit here changes running orchestrators and workers at once, and Claude Code refuses auto-mode edits inside a loaded plugin folder.
- Try Foreman against scratch repos outside this folder too, with `bun src/cli.ts` from your worktree. `foreman` on PATH runs the clone at `~/.local/share/foreman`, not this checkout.
- Run `git config core.hooksPath scripts/git-hooks` once in this checkout, and every `git pull` here that brings in new commits fast-forwards `~/.local/share/foreman` to `origin/main` too. It prints one line when it can't. A pull that says "Already up to date" runs no hooks, so it leaves the clone alone.
- Git worktrees share one stash list, so stash in one worktree at a time.

## Checks

- `bun run test` and `bun run typecheck` are the gate. `bun run test` runs the test files in parallel, about four times faster than a bare `bun test`, which runs them one at a time. GitHub Actions fails every job on a billing error for now, so CI tells you nothing.
- Tests drive pure functions with `tempRepo()` and `fakeTerminal()` from `test/helpers.ts`, never real tabs or `claude` sessions. Code the watcher calls takes its outside world as probes, like `scan` in `src/watch.ts`.

## Rules

- Every new line in a task's `events.jsonl` wakes the orchestrator. Log Foreman's own steps with `logRun` instead.
- Record what you learn about how Claude Code, Rex, git or gh behave in `docs/findings.md`.
- A change to what the orchestrator, a worker or the reviewer should do updates `agents/`, `skills/` or `prompts/` in the same PR, and the README covers anything a user sees.
- Docs, CLI output and prompts use Foreman's words: orchestrator, worker, reviewer, task, brief, decision. Write plain sentences, one idea each, with a plain dash where you'd reach for an em dash.
- Commits and PRs follow `.claude/skills/pull-request`.
- Releases come from the PR that release-please opens on `main`. Never edit the version in `.claude-plugin/plugin.json` or `.release-please-manifest.json` by hand.
