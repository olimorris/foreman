# Rex

[Rex](https://www.superlogical.com) is the default terminal. Foreman needs no setting to use it.

## Requirements

- macOS
- The `rex` command on your PATH
- Run `foreman up` from inside a Rex session, so Foreman can open tabs beside it

## Setup

1. Install Rex and check that `rex` runs in a shell.
2. Open Rex in your repo and run `foreman up`.
3. Run `foreman doctor` to confirm Foreman can find `rex`.

## How Foreman drives it

`rex.sh` in this folder wraps the `rex` CLI. Each worker is a Rex tab, and the status pane opens beside the orchestrator. Rex only resolves a window or block id within the session it belongs to, so every tab keeps its session. Foreman clears `REX_SESSION` and `REX_BLOCK` in a worker, so a user hook in the worker can't act on the orchestrator's session.
