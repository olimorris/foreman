---
name: recover
description: Pick up Foreman work after a restart, a worker whose tab closed, or a missing worktree.
---

# Recover

1. Call `status`. The SessionStart summary also says which worker tabs are open and whether worktrees exist. To see what happened while you were down, such as a worker that went quiet or was restarted, call `timeline`.
2. For each task in flight:
   - **Worker running, status running**: nothing to do.
   - **Status done, blocked or needs-decision**: handle it as if the watcher had just reported it.
   - **Worker tab closed** (or the watcher reported `exited`): look at `git -C <worktree> log --oneline <base>..HEAD` and `git -C <worktree> status`. Tell the user what's there, then ask whether to resume the worker with `resume` or tear the task down. Don't decide for them when the work is unmerged. If the tab closed as soon as it opened because Claude Code refused the task's model, call `resume` with another `model`.
   - **Status over-budget**: the watcher stopped the worker. Tell the user what it has spent, and resume it only after they raise the limit.
   - **Worktree missing**: the task can't continue. Tell the user, then call `teardown` for it, which still refuses while the branch has unmerged commits.
3. If the plan is approved and `status` shows no `baseline:` line, or says `baseline: stopped before it finished`, the baseline stopped with your last session. Start `foreman baseline` in the background again.
4. `status` lists questions still waiting on the user. Ask them again, with your call. The watcher reports any that run out of time.
5. Start `foreman watch` in the background once anything is in flight.

When the user asks how the night went, point them at `foreman timeline` and the run summary, which the `summary` tool writes, rather than retelling either.
