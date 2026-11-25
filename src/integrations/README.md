# Integrations

Foreman runs its orchestrator and workers in terminal tabs. A terminal integration tells Foreman how to open, message, check and close those tabs in one terminal app. Each folder here is one integration. Foreman uses the one whose terminal it's running in, and Rex when none says so. `FOREMAN_TERMINAL=<folder name>` overrides that.

## Adding a terminal

1. Make a folder here named after the terminal, such as `tmux/`. Foreman finds it by its folder, so there is no list to edit.
2. In its `index.ts`, export an object that implements `Terminal` from `src/terminal.ts`, either as the default export or as a named export called after the folder. Each tab is a `Tab` of session, window and pane ids, in whatever form the terminal uses. Foreman stores them with the task and passes them back unchanged.
3. Add a `README.md` in the folder with the terminal's requirements and setup, and what you learned about driving it. This is what `docs/findings.md` holds for the rest of Foreman.
4. Give it an `inside(env)` that says whether a process with that environment runs in this terminal, usually from `TERM_PROGRAM`. Foreman asks every integration when `FOREMAN_TERMINAL` isn't set. Without `inside`, the integration is only used when `FOREMAN_TERMINAL=<name>` selects it. `foreman doctor` lists every folder it found.

A folder that fails to load just doesn't say yes, so a broken integration doesn't affect the others. If two integrations both say yes, Foreman asks the user to set `FOREMAN_TERMINAL`.

The integration must:

- open a tab running a command, in a given folder, without taking focus away from the user
- say whether a tab's process is still running
- type text into a tab and press Enter, for workers whose message socket is gone
- close a tab, which must end the process running in it
- optionally, open a pane beside another one for the status pane. Without it, `foreman pane` opens the status pane in its own tab
- name the environment variables it sets in a tab, so workers don't inherit the orchestrator's session
