# 10. When the account hits its usage limit, Foreman pauses every worker, starts nothing new and resumes after the reset

A worker at its limit isn't hung, and restarting it would hit the same limit. Waiting keeps a run going unattended for subscription users. Rejected: treating a limited worker as hung, which nudges and restarts it into the same limit.
