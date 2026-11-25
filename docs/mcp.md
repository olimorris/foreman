# Foreman as an MCP server

The orchestrator and workers drive Foreman by running the `foreman` CLI through the Bash tool. Claude Code plugins can also ship an MCP server, which would turn those commands into tools. This note weighs up whether that would be better. It was checked against Claude Code 2.1.332 and the docs listed under Sources.

## How the CLI is used today

- The orchestrator runs about 30 commands, from `foreman status` to `foreman deliver`. `foreman up` starts it with `--allowedTools "Bash(foreman *)"`, so none of them asks for permission.
- A worker runs four: `report`, `propose`, `note` and `tidy`. It gets the same `Bash(foreman *)` rule, plus rules for `git add`, `git commit` and `git rebase`.
- The reviewer runs none. It's a `claude -p` call limited to Read, Grep and Glob, and it answers in a JSON schema.
- A few commands aren't calls an agent makes and waits on. `foreman watch`, `foreman baseline` and `foreman together` run as background commands and wake the orchestrator through its messaging socket. `foreman review` opens its own tab. `hooks/hooks.json` runs `foreman hook` for SessionStart, Stop and PreToolUse. `foreman up`, `foreman doctor` and `foreman pane` are for the user.
- The README installs Foreman from a clone, and Foreman passes `--plugin-dir` to the orchestrator and worker sessions it starts. So the plugin loads only in those sessions. A marketplace install, which `pluginArgs` in `src/paths.ts` also supports, loads it in every session.
- The CLI knows who is calling from `FOREMAN_ROLE` and `FOREMAN_TASK`, which `foreman up` and `foreman spawn` set when they start each session. `foreman report` and `foreman propose` use `FOREMAN_TASK` to know which task they belong to.
- The agent definitions and skills name a `foreman` command 138 times.

## Which commands would become tools

| Who calls it | Commands that would become tools | Stays a command |
|---|---|---|
| Worker | `report`, `propose`, `note`, `tidy` | - |
| Orchestrator | `status`, `plan`, `next`, `spawn`, `send`, `review`, `feedback`, `deliver`, `sync`, `teardown`, `pause`, `resume`, `restart`, `budget`, `cost`, `summary`, `timeline`, `decisions`, `accept`, `reject`, `ask`, `answer`, `propose`, `adr`, `note`, `notes`, `shots`, `tidy` | `watch`, `baseline` and `together`, which must keep running after the orchestrator's turn ends |
| Reviewer | none | - |
| A user in a plain Claude Code session, with a marketplace install | read-only ones: `status`, `timeline`, `summary`, `cost`, `budget`, `notes`, `decisions` | `up`, `doctor`, `pane` |
| Claude Code itself | - | `hook` |

So an MCP server would sit beside the CLI, not replace it. Every command the server offers would have two front doors.

## What gets better

- **No shell quoting.** A message, a decision body or a test step goes in as a JSON string. Today a body with quotes, backticks or `$` has to go through `--body-file` to survive the shell.
- **Per-role tools.** Each tool can be allowed by name, such as `mcp__plugin_foreman_foreman__report`, so a worker could be given only its four tools. Today `Bash(foreman *)` would let a worker run `foreman accept` on its own proposal. Narrower Bash rules, such as `Bash(foreman report *)`, close the same gap without a server.
- **No command text to judge.** A Bash allow rule matches the command's text. `docs/spikes.md` records auto mode's classifier judging a whole code mode script before any allow rule, and judging a chained command unless every part matches a rule. An MCP tool is allowed by its name, with no command text to parse. Whether code mode's classifier still judges it hasn't been tried.
- **Found without knowing the CLI.** With a marketplace install, tool search in a plain session can find a `status` tool when the user asks how the run is going. With the README's install, the plugin isn't loaded there, so this gains nothing. Foreman's own sessions gain nothing either, because their prompts name every command.
- **Pushing into a session.** An MCP server can declare the `claude/channel` capability and push messages into a session started with `--channels`. That's the one thing a CLI can't do, and it could replace the messaging socket the watcher uses to wake the orchestrator. Channels are a research preview, and the socket already works.

Structured results barely change. The reader is a model, most output is one line written for it, and `foreman status --json` already exists.

## What gets worse

- **Two front doors.** Every command needs its arguments, errors and output kept the same in the CLI and the server, and tested in both.
- **A process in every session.** Claude Code starts an enabled plugin's MCP servers at the start of every session. With a marketplace install, that's every Claude Code session the user opens, in any repo. Today the hooks run there too, but they exit at once when `FOREMAN_ROLE` isn't set. A stdio server keeps running for the whole session, and its tool names load at the start of every session.
- **The reviewer could see the tools.** The reviewer isn't started with `--plugin-dir`, but with a marketplace install the plugin loads there too. `--tools` doesn't limit MCP tools, so unless the reviewer is started with `--disallowedTools "mcp__*"` or `--strict-mcp-config`, it could call `accept` or `deliver`.
- **Fixes land later.** Each `foreman` call runs the checkout's current code, so a fix reaches running orchestrators and workers on their next call. A server keeps the code it started with until its session restarts.
- **Who is calling is unproven.** The docs don't say whether a stdio server inherits the environment `claude` was started with, so `FOREMAN_TASK` may not reach it. They do say `CLAUDE_PROJECT_DIR` is set, and a worker's project folder is its worktree, which names one task. That should be enough, but it hasn't been tried.

## What it would take to build

1. Spike the environment question, and record what a stdio server inherits in `docs/spikes.md`.
2. Add `@modelcontextprotocol/sdk` and a `src/mcp.ts` stdio server. Bun runs it with no build step. Declare it in a `.mcp.json` at the plugin root, started with `${CLAUDE_PLUGIN_ROOT}`.
3. Split each command in `src/cli.ts` into a function that takes typed arguments and returns its text. Today each case parses flags, does the work and prints, so this touches every command.
4. Work out who is calling from `CLAUDE_PROJECT_DIR`, and offer each role only its tools. Offer no tools outside a Foreman repo, so unrelated sessions stay clean.
5. Replace `Bash(foreman *)` with tool rules in `foreman up` and `workerCommand`, and keep the server away from the reviewer.
6. Rewrite the 138 command mentions in `agents/` and `skills/`, and the README.

## Recommendation

Keep the CLI as Foreman's only interface, and don't build an MCP server now.

The CLI has to stay for the hooks, the watcher, the review tab and the user's own commands. A server would add a second copy of most of it, need every prompt rewritten, and with a marketplace install start a process in every Claude Code session. Its real gains are small and mostly reachable without it. Narrower allow rules, like `Bash(foreman report *)` for workers, stop a worker running orchestrator commands. File inputs like `--body-file` handle text the shell would mangle.

Look again if channels leave research preview and the messaging socket starts to cause trouble. Pushing into a session is the one thing only an MCP server can do. Even then, a server that only pushes the watcher's lines would do, with every command staying in the CLI.

## Sources

- Claude Code docs, [MCP](https://code.claude.com/docs/en/mcp): "Plugin-provided MCP servers" ("When you enable a plugin, Claude Code starts its MCP servers automatically"), "Scale with MCP tool search", the stdio section on `CLAUDE_PROJECT_DIR`, and [Push messages with channels](https://code.claude.com/docs/en/mcp#push-messages-with-channels).
- Claude Code docs, [Plugins reference](https://code.claude.com/docs/en/plugins-reference): `.mcp.json` and `mcpServers`, "Environment variables" and "Where each variable resolves".
- Claude Code docs, [Permissions](https://code.claude.com/docs/en/permissions): MCP tool names (`mcp__plugin_<plugin>_<server>__<tool>`), wildcards, and what a Bash rule doesn't match.
- Claude Code docs, [CLI reference](https://code.claude.com/docs/en/cli-reference): `--tools` "doesn't affect MCP tools", `--disallowedTools` and `--strict-mcp-config`.
- This repo: `README.md`, `src/cli.ts`, `src/paths.ts` (`pluginArgs`), `src/spawn.ts` (`workerCommand`), `src/review.ts` (`reviewerCommand`), `src/hooks.ts`, `hooks/hooks.json`, `agents/`, `skills/`, `prompts/reviewer.md` and `docs/spikes.md`.
