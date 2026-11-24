---
name: recover
description: Pick up Foreman work after a restart, a worker whose tab closed, or a missing worktree.
---

# Recover

1. Run `foreman status`. The SessionStart summary also says which worker tabs are open and whether worktrees exist.
2. For each task in flight:
   - **Worker running, status running**: nothing to do.
   - **Status done, blocked or needs-decision**: handle it as if the watcher had just reported it.
   - **Worker tab closed** (or the watcher reported `exited`): look at `git -C <worktree> log --oneline <base>..HEAD` and `git -C <worktree> status`. Tell the user what's there, then ask whether to respawn a worker on the same worktree or tear the task down. Don't decide for them when the work is unmerged.
   - **Worktree missing**: the task can't continue. Tell the user, then run `foreman teardown <id>`, which still refuses while the branch has unmerged commits.
3. Start `foreman watch` in the background once anything is in flight.
