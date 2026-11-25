# Spikes

Findings that shaped the design, checked against Claude Code 2.1.331 and Rex 0.1.0-preview.19 on macOS.

## Messaging socket

- `claude --messaging-socket-path <path>` sets where a session binds its inbox. Foreman picks the path at spawn time, so it never has to discover a worker's socket.
- The socket's directory must be a real directory with mode 700. `/tmp` is refused because it's a symlink.
- One line per message: `{"type":"user","message":{"role":"user","content":"..."}}`. No auth line is needed on macOS for a socket you own.
- An idle session starts a turn with the message. The receiver is told the message came from another session, along with a warning against permission laundering.

## Waking the orchestrator

- A background command that exits doesn't reliably wake an idle session. These sessions run with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` from user settings, where Bash runs inside a script.
- So the watcher posts its line to the orchestrator's socket as well as exiting. The socket wake was proven above.

## Rex

- `rex block call -b <block> process` returns `child: null` once the program has exited. With `--keep-open`, a closed worker stays readable and is still detected as exited.
- `rex window new` uses the login shell's environment, not the caller's.
- Rex finds a block or window id only within the session given with `-s`, so every task records its session alongside its tab.

## Folder trust

- A new worktree under `.foreman/worktrees/` shows Claude Code's trust dialog even when a folder above the repo is trusted. The repo root itself didn't prompt.

## Permissions

- Without `--allowedTools "Bash(foreman *)"`, the orchestrator has to ask before every `foreman` call. In `-p` mode that left the Stop guard and the blocked tool calls going round in a loop until the block budget ran out.
- Workers inherit the user's global instructions. A rule like "never run git commit" overrides the worker's brief.
- Auto mode's classifier blocked a worker's `git commit` even with `--allowedTools "Bash(git commit *)"`. Two things got in the way. In code mode the classifier judges the whole script before any allow rule is checked. And a chained command such as `git add && git commit && git log` only skips the classifier when every part matches an allow rule. What worked: launch workers with code mode off (`--settings '{"env":{"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"0"}}'`) and grant the commit in the worker's first prompt, which the classifier counts as the user's intent.
- `--allowedTools`, `--add-dir` and `--tools` take any number of values, so they swallow a prompt that follows them. Put `--` before an interactive prompt, and pipe a `-p` prompt on stdin.
- Workers share the orchestrator's Rex session, and a user hook that tells every Claude session to name its Rex session makes each worker rename it. The worker instructions forbid renaming.

- Auto mode refuses every Edit and Write inside the directory of a loaded `--plugin-dir` plugin, with "the classifier gave no verdict". Scratch repos for testing Foreman must live outside the plugin folder.
- A new repo root shows the trust prompt too, and a message typed into it answers "No" and exits. `foreman up` pre-trusts the repo root.
- Any `claude` started with `REX_SESSION` set follows the user's hook and renames that Rex session. Workers start without `REX_SESSION` and `REX_BLOCK`.

## Processes

- `lsof -d cwd -F pn` lists the working directory of every process in about 0.15 seconds, so the watcher runs it once a pass for all the worktrees.
- A worker's claude process runs each Bash command as `/bin/zsh -c source <snapshot> && eval '<command>'`, so the command the worker typed is that shell's child. The claude process also starts `caffeinate` and LSP servers such as `sourcekit-lsp` in the worktree, and they sit at 0% CPU.
- macOS `ps -o time` prints CPU time as minutes and seconds, with the minutes running past 60, like `296:01.75`. The watcher compares this between passes, because `%cpu` is a decaying average that stays up after a build stops.
- `ps -o time` leaves out children that have exited. The man page says `-S` adds them to the parent, but on macOS 27.2 it adds nothing: a shell that had waited on a child using 2 seconds of CPU still showed `0:00.01` with and without `-S`. So a serial make whose compiler runs are short looks idle by CPU time, and the watcher counts a new process in the worktree as a sign of work instead.
- Claude Code restarts `caffeinate -i -t 300` under the worker every 5 minutes, so new processes whose parent is the worker's claude process don't count as work.
- On macOS a process whose parent exits moves to launchd, pid 1. Rex tabs run under `rex server`, so a worker's claude process always has a live parent.
- A hung `timeout 900 swift test -j 3` showed as `timeout`, `swift-test` and `swiftpm-testing-helper`, all at 0% CPU.

## Base branch

- The user's local `main` lags behind merged PRs. Spawns, reviews, delivery and teardown all compare against `origin/<base>` when it exists, or a stale checkout puts other tasks' merged work into a review's diff.

## macOS screenshots

- Launching the app's executable directly never makes its window key, so it doesn't steal focus. Accent-coloured controls render grey in these captures.

## Reviewer

- `claude -p --agent <name> --json-schema …` returns prose with `structured_output` empty. Without `--agent`, the schema is honoured. So the reviewer runs with `--append-system-prompt-file prompts/reviewer.md --tools Read,Grep,Glob`.
