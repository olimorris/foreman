# Orca

[Orca](https://github.com/stablyai/orca) is a desktop workspace for coding agents. Foreman can run its orchestrator and workers as Orca terminal tabs.

## Requirements

- macOS 13.4 or later. On Linux, `orca` on PATH is usually the GNOME screen reader, and Orca's own CLI is `orca-ide`, which Foreman doesn't call.
- The `orca` command on your PATH. It ships with the app, and you turn it on under Settings > General > Orca CLI.
- Orca must be running. Foreman drives the app through the CLI and doesn't start it.
- Your repo added to Orca as a project, so Orca has a workspace for its folder.

Written against Orca 1.4.274 from its source and docs. It hasn't been run against a real Orca yet.

## Setup

1. Install Orca with `brew install --cask stablyai/orca/orca`, or download it from [Orca's releases](https://github.com/stablyai/orca/releases/latest).
2. Open Orca, add your repo as a project, and turn on the CLI under Settings > General > Orca CLI.
3. Check that `orca status --json` runs in a shell.
4. Set `FOREMAN_TERMINAL=orca` in your shell profile, so every `foreman` command uses Orca.
5. Run `foreman doctor` to confirm Foreman can find `orca`.
6. Run `foreman up` from the repo. The orchestrator opens as a tab titled `foreman-<repo>` in the repo's Orca workspace, and the status pane opens as a tab beside it.

## How Foreman drives it

- A session is an Orca workspace id, like `repo-1::/Users/me/code/app`. Inside an Orca terminal Foreman reads it from `ORCA_WORKTREE_ID`.
- `foreman up` opens the orchestrator with `orca terminal create --worktree path:<repo> --focus`, and finds an existing one by looking for a tab with its title in `orca terminal list --include-visual-layouts`.
- Each worker is a tab in the orchestrator's workspace, opened with `orca terminal create`. Without `--focus`, Orca adds the tab without switching to it.
- Foreman keeps its own worktrees. Orca can make worktrees too, with `orca worktree create`, but Foreman doesn't use that. A worker's tab sits in the main repo's workspace and moves into the worker's worktree itself.
- Orca types `--command` into your login shell rather than running it directly, so a command that's quoted for sh breaks in fish. Foreman writes the command to a small sh script in the temp folder and types `exec /bin/sh '<script>'`, which reads the same in every shell. The script deletes itself, moves into the worktree and replaces itself with the worker.
- `alive` asks `orca terminal show`. A terminal that has exited, or one Orca no longer knows, counts as gone.
- `send` uses `orca terminal send --text ... --enter`, and `close` uses `orca terminal close`, which stops the process in the pane.
- Orca sets `ORCA_WORKTREE_ID`, `ORCA_TERMINAL_HANDLE` and other `ORCA_*` variables fresh in every pane, so a worker never sees the orchestrator's values. Foreman leaves them alone, so Orca can still show each worker's agent status.

## What doesn't work as well as in Rex

- The status pane opens as its own tab, not beside the orchestrator. `orca terminal split` has no way to stop the new pane taking focus, so Foreman doesn't split.
- A worker's tab stops when the worker exits, because the shell is replaced by the worker. Rex keeps a finished tab open so you can read its last output. Whether Orca keeps an exited pane on screen is up to Orca.
- Terminal handles only last while Orca is running. After Orca restarts, Foreman sees every worker as gone. Run `foreman resume <task>` to start them again.
- Every worker is a tab in one workspace, so Orca's sidebar shows one card for the repo, not one per task.
- `orca terminal send` with Enter is refused while Claude Code shows a permission menu. Foreman only types into a worker when its message socket is gone, so this rarely matters.
