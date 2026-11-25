# Ghostty

Foreman can run its orchestrator and workers in [Ghostty](https://ghostty.org) tabs on macOS. It drives Ghostty through Ghostty's AppleScript dictionary.

## Requirements

- macOS
- Ghostty 1.4 or later. Foreman finds its tabs by a terminal's tty and a tab's title override, and both arrived in 1.4
- AppleScript left on in Ghostty, which is the default. `macos-applescript = false` in your Ghostty config turns it off
- Automation permission for the app you run `foreman` from to control Ghostty. macOS asks the first time. If you said no, allow it in System Settings > Privacy & Security > Automation

## Setup

1. Set `FOREMAN_TERMINAL=ghostty` in your shell, such as `export FOREMAN_TERMINAL=ghostty` in your shell's startup file.
2. Run `foreman doctor`. It checks that Ghostty is installed, its version, and that AppleScript is on.
3. Open Ghostty in your repo and run `foreman up`. The orchestrator opens in a new Ghostty window, with the status pane beside it.

Run later `foreman` commands, such as `foreman pane`, from the orchestrator's tab. Workers open as tabs in the same window.

## What doesn't work as well as in Rex

- Ghostty always selects a new tab and asks macOS to bring Ghostty to the front. Foreman selects the tab you were on again straight after, so you may see a flicker. If you were in another app, Ghostty may come to the front.
- A worker's tab stays open after the worker exits, showing Ghostty's prompt to press any key. Ghostty keeps every tab opened with a command, so Foreman can't choose. The review tab runs a last step that closes its own tab.
- The status pane takes half the orchestrator's tab, since Ghostty's split has no size. Drag the divider to resize it.
- Tabs get Ghostty's environment plus the `PATH` that `foreman` ran with. Variables your shell's startup files set don't reach the orchestrator or workers. Set them with `env` in your Ghostty config instead.
- If Ghostty isn't running, `foreman up` launches it, and Ghostty may open its own empty window as well.

## How Foreman drives it

`ghostty.applescript` in this folder holds every call Foreman makes, run with `osascript`. `index.ts` builds the arguments and reads the replies. Ghostty's dictionary is in `sdef /Applications/Ghostty.app`.

- A session is the terminal Foreman was run from, not a Ghostty window. A window's id is built from the AppKit objects behind it and can change as tabs come and go. A terminal's id is a UUID that lasts as long as the terminal, so Foreman finds the window that holds it each time.
- Ghostty sets `GHOSTTY_SURFACE_ID` in each terminal, but it's a different number from the AppleScript terminal id. Foreman finds its own terminal by walking up its process tree to the first process with a tty, since Claude Code runs commands detached from it, and matching that against each terminal's `tty`.
- Ghostty runs a tab's command as `login -flp <user> bash --noprofile --norc -c "exec -l <command>"`, and forces `wait-after-command` on. So the command must be one shell-quoted command line, and a tab that should close runs `/bin/sh -c '<command>; osascript ghostty.applescript close-tty "$(tty)"'`.
- A tab whose command has exited still exists, so Foreman counts a worker as running while any process holds its terminal's tty, checked with `ps -t`.
- Checks such as the watcher's never launch Ghostty, because the script asks whether Ghostty is running before it sends anything. Compiling the script reads the dictionary from the app bundle without launching Ghostty.
- `close tab` and `close` skip Ghostty's close confirmation and end the process in the tab.
- `select tab` doesn't activate Ghostty since 1.3.1. `focus` raises the window and activates Ghostty, so Foreman moves focus back from the status pane with the `goto_split:left` action instead.
- `input text` pastes into a terminal without focusing it, and `send key "enter"` submits.
