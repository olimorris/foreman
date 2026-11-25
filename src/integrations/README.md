# Integrations

Foreman runs its orchestrator and workers in terminal tabs. A terminal integration tells Foreman how to open, message, check and close those tabs in one terminal app. Rex is the only one so far.

## Adding a terminal

1. Make a folder here named after the terminal, such as `tmux/`.
2. In its `index.ts`, export an object that implements `Terminal` from `src/terminal.ts`. Each tab is a `Tab` of session, window and pane ids, in whatever form the terminal uses. Foreman stores them with the task and passes them back unchanged.
3. Register it in `TERMINALS` in `index.ts` in this folder.
4. Select it with `FOREMAN_TERMINAL=<name>`. Rex is the default.

The integration must:

- open a tab running a command, in a given folder, without taking focus away from the user
- say whether a tab's process is still running
- type text into a tab and press Enter, for workers whose message socket is gone
- close a tab, which must end the process running in it
- optionally, open a pane beside another one for the status pane. Without it, `foreman pane` opens the status pane in its own tab
- name the environment variables it sets in a tab, so workers don't inherit the orchestrator's session
