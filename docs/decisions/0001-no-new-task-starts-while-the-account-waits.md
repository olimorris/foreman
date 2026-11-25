# 1. No new task starts while the account waits for its usage limit to reset

Starting a task while the account waits for its usage limit to reset only leaves a new worker idle, so `foreman next` and `foreman spawn` refuse until the reset. The check sits beside the budget check in the CLI, so a stray `foreman next` can't get past it. Rejected: holding tasks back in the plan's scheduling, which would show every waiting task with the wrong reason, and leaving it to the orchestrator's prompt, which nothing enforces.
