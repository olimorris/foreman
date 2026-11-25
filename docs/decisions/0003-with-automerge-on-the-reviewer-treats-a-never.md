# 3. With automerge on, the reviewer treats a never rule about merging that a PR falls under as an issue

Automerge only touches `foreman/<id>` branches, which keeps release PRs out, but a rule such as "never merge a PR that changes a migration" would otherwise go unchecked. With automerge on, the reviewer's prompt says that approving merges the PR, so a never rule about merging that the PR falls under is an issue. Rejected: parsing the free-text rules in code, which is unreliable, and refusing automerge whenever a rule mentions merging, which the release-PR rule alone would trigger.
