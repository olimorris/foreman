# Herdr

[Herdr](https://github.com/herdrdev/herdr) is a terminal multiplexer for coding agents. Foreman can run its orchestrator and workers as tabs in a Herdr workspace.

Several GitHub repos are called herdr, and most are forks. The official one is `herdrdev/herdr`, with docs at [herdr.dev/docs](https://herdr.dev/docs/). It was first published as `ogulcancelik/herdr`, which now redirects there.

## Requirements

- Herdr 0.7.0 or later. In 0.7.0 pane ids became stable handles like `w1:p2`, so a closed worker's pane id can't later point at another pane.
- The `herdr` command on your PATH.
- A running Herdr server. Foreman drives Herdr through its CLI and doesn't start the server.
- Run `foreman up` from a pane inside Herdr, so later `foreman` commands know which workspace they're in.

Written against Herdr 0.9.5 from its source and docs. It hasn't been run against a real Herdr yet.

## Setup

1. Install Herdr with `brew install herdr`, or `curl -fsSL https://herdr.dev/install.sh | sh`.
2. Set `FOREMAN_TERMINAL=herdr` in your shell profile, so every `foreman` command uses Herdr.
3. Start Herdr by running `herdr` in your terminal.
4. Run `foreman doctor` in a Herdr pane. It checks that `herdr` is on your PATH, its version, and that its server is running.
5. Run `foreman up` from your repo. The orchestrator opens in a new Herdr workspace named `foreman-<repo>`, with the status pane beside it.

## How Foreman drives it

Foreman calls the `herdr` CLI, which talks to the running server over Herdr's socket API. Every call prints JSON, and a failed call prints a JSON error on stderr and exits with status 1.

- A session is a Herdr workspace id, like `w1`. Inside a Herdr pane Foreman reads it from `HERDR_WORKSPACE_ID`, and its own pane from `HERDR_PANE_ID`.
- `foreman up` opens the orchestrator with `herdr workspace create --label foreman-<repo> --focus`, and finds an existing one by its label in `herdr workspace list`.
- Each worker is a tab in the orchestrator's workspace, opened with `herdr tab create --no-focus`, so the tab you're on keeps focus.
- The status pane opens with `herdr pane split --direction right --ratio 0.65`. The ratio is the share the split pane keeps, so the status pane gets the other 35%.
- Herdr can't start a tab or split with a command. A new pane starts your login shell, and Foreman types into it with `herdr pane run`. That shell may be fish, so Foreman writes the command to a small sh script in the temp folder and types `exec /bin/sh '<script>'`, which reads the same in every shell. The script deletes itself, moves into the worktree and replaces itself with the worker.
- Herdr removes a pane as soon as its process exits. So `alive` only asks `herdr pane get` whether Herdr still knows the pane.
- `send` types with `herdr pane send-text`, then presses Enter with `herdr pane send-keys enter`. `herdr pane run` would send both in one write, and Herdr's own `agent prompt` delays the Enter so a coding agent doesn't read it as part of the pasted text.
- `close` uses `herdr pane close`, which ends the process in the pane. Closing a tab's only pane closes the tab.
- Herdr sets `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` fresh in every pane, so a worker never sees the orchestrator's values. Foreman leaves them alone, so the worker's `herdr` calls reach the same server and Herdr can still show the worker's agent status.
- `layout.apply` in the raw socket API can start a pane with a command, but it has no CLI wrapper and can't split an existing tab, so Foreman doesn't use it.

## What doesn't work as well as in Rex

- A worker's tab closes when the worker exits, because Herdr removes a pane once its process ends. Rex keeps a finished tab open so you can read its last output.
- Herdr keeps its panes when the server restarts, but not the processes in them. After a restart, a worker's pane comes back with the same id but without the worker Foreman started, so Foreman still counts the worker as running. Run `foreman restart <task>` to start it again.
- `herdr pane send-text` types into the pane even while Claude Code shows a permission menu. Foreman only types into a worker when its message socket is gone, so this rarely matters.
- The status pane's label is set with a second call, `herdr pane rename`, since `pane split` takes no label. If that call fails, the pane still opens without a label.
