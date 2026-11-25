# 2. A terminal integration adds its own foreman doctor checks through an optional checks() on Terminal

Some terminals need more than a binary on PATH: Ghostty must be 1.4 or later with AppleScript turned on. Each integration can export `checks()`, which returns named results, and `foreman doctor` runs them after the binary checks. Rejected: terminal-specific checks in `src/doctor.ts`, which breaks one folder per terminal (ADR 5), and shell snippets in `requires`, which doctor would run unquoted.
