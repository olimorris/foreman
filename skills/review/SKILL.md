---
name: review
description: Review a finished Foreman task, relay feedback to its worker, and set up screenshots for a repo. Use when a worker reports done or a review verdict arrives.
---

# Review

## When a worker reports done

Call `review` for the task. It opens a `review <id>` tab, which:

1. Captures screenshots of every screen named in the brief's `## Screens` section: before (the base branch, cached by commit) and after (the task branch).
2. Runs a fresh read-only reviewer on the diff, the brief, the decisions it touches and the screenshots.
3. Wakes you with one line: `reviewed T1: approve, round 1, risk low: …` or `reviewed T1: changes, round 1, 2 issue(s): …`.

Keep the screenshots out of your own context. The verdict line is all you need.

## When the verdict arrives

- **approve**: call `deliver` for the task. It pushes the branch and opens the PR with the review packet. Tell the user in one line with the PR link and the risk. With automerge off, the user merges it. With it on, Foreman merges it once every check passes, and the `merged` line wakes you as usual. You never merge a PR yourself. If its note names tasks that can start on top of it, call `next`. If it says other tasks build on this branch, call `sync`. If two or more PRs are now open, start `foreman together` in the background.
- **changes**: call `feedback` for the task. It sends the reviewer's issues, each anchored to a screenshot, screen or file and the intent it breaks, to the same running worker. The worker fixes them and reports done again. Review again.
- **"revision limit reached"**: after two revision rounds, stop. Tell the user what's still wrong, in one line per issue, and point them at the screenshots in `.foreman/tasks/<id>/review/round-<n>/`. Ask whether to send a third round, take over the task, or merge as is.
- **failed**: read the capture log or `reviewer.json` named in the line, fix the setup if you can, then review again.

## Set up the test command once per repo

`foreman together` runs the repo's tests on the open PRs merged together. If `.foreman/config.json` has no `test` entry, work the command out from the repo: its README, `package.json` scripts, `Package.swift`, `Makefile` or CI workflow. Add `test` and `testMinutes` entries to the existing file, keeping everything else in it:

```json
"test": "bun install && bun test",
"testMinutes": 15
```

It runs in a fresh checkout with nothing installed or built, so include the setup the tests need. Foreman stops it after `testMinutes` (default 15), so raise that for a slow suite.

## Set up screenshots once per repo

Add a `screenshots` entry to `.foreman/config.json`, then check it by calling `shots` for a running task.

Web:

```json
{ "screenshots": { "adapter": "web", "install": "npm ci", "start": "npm run dev -- --port {port}", "url": "http://localhost:{port}" } }
```

Each worktree gets its own port. Briefs list routes: `- settings: /settings`.

macOS:

```json
{ "screenshots": { "adapter": "macos", "prepare": "xcodegen generate",
  "build": "xcodebuild -project App.xcodeproj -scheme App -configuration Debug -derivedDataPath {derivedData} CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build",
  "app": "{derivedData}/Build/Products/Debug/App.app", "settleSeconds": 5 } }
```

Each build gets its own DerivedData. Foreman copies the app and gives the copy its own bundle id. It removes the copy's extensions, signs it locally, then launches it with its own HOME, so several copies never share preferences or Application Support. Keep signing local, as above, so building never registers new App IDs on the user's developer account. Briefs list launch arguments: `- editor: -OpenSampleRecording YES`, or nothing after the colon for a plain launch.

The terminal app running the review tab needs Screen Recording permission (System Settings > Privacy & Security > Screen & System Audio Recording). `foreman doctor` checks it.
