# Decisions, one per file

Decisions that are hard to reverse, would surprise a reader of the code, and came from a real trade-off.

- The title states the decision. It's the only part always read.
- One decision per record. Say what is true now and why, with what was rejected.
- A new record takes one above the highest number in this folder, `superseded/` included, as `NNNN-short-name.md`.
- When a decision is reversed, move its file to `superseded/`, add "Superseded by ADR N." under its title, and write the new decision as a new record.
