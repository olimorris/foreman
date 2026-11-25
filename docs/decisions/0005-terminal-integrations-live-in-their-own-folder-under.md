# 5. Terminal integrations live in their own folder under src/integrations, and Foreman finds them by folder

Adding a terminal never edits a shared file, so Ghostty, Orca and Herdr were built side by side. Each folder's README holds that terminal's setup and what was learned about driving it. Rejected: a hand-kept list of terminals in `src/integrations/index.ts`, which every new terminal would edit, so no two could be built at once.
