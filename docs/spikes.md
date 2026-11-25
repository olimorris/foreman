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

## Usage limit

Checked against Claude Code 2.1.332 without spending usage: its docs, its changelog, its binary's strings and transcripts already on this machine. None of those transcripts had hit a usage limit, so the line Foreman matches is inferred from other API errors.

- The tab shows "You've hit your session limit · resets 3:45pm" or "You've hit your weekly limit · resets Mon 12:00am". The time is the machine's local time, with no date unless it's further out.
- `autoContinueAtUsageLimit` defaults to true. An interactive session then waits with "Continuing automatically at 3:45pm · Esc to cancel" and carries on by itself at the reset, up to three times in a row. It doesn't wait if Claude Code exits or relaunches during the wait.
- `claude -p` never waits. It exits with the limit message as its result, so a review that hits the limit fails unless Foreman reruns it.
- Every API error lands in the transcript as an assistant line with `"model":"<synthetic>"`, `"isApiErrorMessage":true`, an `error` type such as `authentication_failed` or `rate_limit`, and the message as its text. There's no reset time field, so Foreman reads it from the text. Versions before 2.1 wrote `Claude AI usage limit reached|<epoch seconds>` instead.
- `error: "rate_limit"` covers ordinary throttling too ("API Error: Rate limit reached"), which Claude Code retries itself. Only text about the usage limit or "hit your limit" counts as the account's limit.
- The only machine-readable reset time is the status line's input: `rate_limits.five_hour.resets_at` and `rate_limits.seven_day.resets_at`, in epoch seconds, for Pro, Max and Ultra accounts only. Using it would mean replacing the user's status line in every worker, so Foreman doesn't.
- The StopFailure hook gets `error: "rate_limit"` with no reset time.
- When the text has no time Foreman can read, it tries again an hour later. A worker resumed too early hits the limit again at no cost and is paused with the new time.

## Telegram

Checked against the Telegram plugin 0.0.7 and Claude Code 2.1.332.

- The plugin is an MCP server that also polls Telegram as a bot. It's published as `telegram@claude-plugins-official`, and Claude Code's plugin directory installs the same plugin as `telegram@anthropic-plugin-directory`. `~/.claude/plugins/installed_plugins.json` lists the ids installed.
- Any session with the plugin enabled starts the server, `claude -p` included, not just sessions started with `--channels`. Telegram allows one poller per bot token, so on start the server sends SIGTERM to the pid in `~/.claude/channels/telegram/bot.pid` and takes over. The newest session always owns the bot, and the one before loses it with no warning.
- `--settings '{"enabledPlugins":{"telegram@<marketplace>":false}}'` keeps the plugin out of one session even when the user enabled it for every session. A `claude -p` run with it had no Telegram tools and left `bot.pid` alone. The same run without it listed the tools and replaced the poller.
- `--channels plugin:<name>@<marketplace>` is a hidden flag. It takes several values, so a prompt after it is read as another channel and fails with "--channels entries must be tagged". Put it before another flag, or end it with `--`.
- Without `--channels`, the `reply`, `react` and `edit_message` tools still work, so pings go out. Messages from Telegram only reach a session started with `--channels`, as `<channel source="telegram" chat_id="..." message_id="..." user="..." ts="...">`.
- Plugin channels must be on Claude Code's approved allowlist, and a Team or Enterprise organisation can turn channels off. A `claude -p` run with `--channels` logged nothing about channels, so check messages from Telegram in an interactive session.
- `reply` needs a `chat_id`. For a direct message it's the user's numeric id, which pairing adds to `allowFrom` in `~/.claude/channels/telegram/access.json`. The token lives in `~/.claude/channels/telegram/.env` as `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_STATE_DIR` moves that whole folder.
