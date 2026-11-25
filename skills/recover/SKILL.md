---
name: recover
description: Pick up Foreman work after a restart, a worker whose tab closed, or a missing worktree.
---

# Recover

1. Run `foreman status`. The SessionStart summary also says which worker tabs are open and whether worktrees exist. To see what happened while you were down, such as a worker that went quiet or was restarted, run `foreman timeline`.
2. For each task in flight:
   - **Worker running, status running**: nothing to do.
   - **Status done, blocked or needs-decision**: handle it as if the watcher had just reported it.
   - **Worker tab closed** (or the watcher reported `exited`): look at `git -C <worktree> log --oneline <base>..HEAD` and `git -C <worktree> status`. Tell the user what's there, then ask whether to resume the worker with `foreman resume <id>` or tear the task down. Don't decide for them when the work is unmerged. If the tab closed as soon as it opened because Claude Code refused the task's model, resume it with `foreman resume <id> --model <name>`.
   - **Status over-budget**: the watcher stopped the worker. Tell the user what it has spent, and resume it only after they raise the limit.
   - **Worktree missing**: the task can't continue. Tell the user, then run `foreman teardown <id>`, which still refuses while the branch has unmerged commits.
3. If the plan is approved and `foreman status` shows no `baseline:` line, or says `baseline: stopped before it finished`, the baseline stopped with your last session. Start `foreman baseline` in the background again.
4. `foreman status` lists questions still waiting on the user. Ask them again, with your call. The watcher reports any that run out of time.
5. Start `foreman watch` in the background once anything is in flight.

When the user asks how the night went, point them at `foreman timeline` and the run summary (`foreman summary`) rather than retelling either.
