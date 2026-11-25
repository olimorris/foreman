# ADR-0002: A terminal integration adds its own foreman doctor checks through an optional checks() on Terminal

## Status

Accepted

## Date

2026-11-25

## Context

A terminal's requirements aren't always binaries on PATH. Ghostty must be 1.4 or later with AppleScript turned on, and `requires` only checks `command -v`.

## Decision

A terminal integration can export an optional `checks()` on `Terminal` that returns named results, and `foreman doctor` runs them after the binary checks.

## Alternatives Considered

### Terminal-specific checks in `src/doctor.ts`

- Pros: Everything doctor checks is in one file.
- Cons: Every terminal edits a shared file.
- Rejected: It breaks one folder per terminal (ADR-0005).

### Shell snippets in `requires`

- Pros: No new interface.
- Cons: Doctor runs them through `sh -c` unquoted.
- Rejected: Unsafe, and it misuses a list of binaries.

## Consequences

- Each integration owns its own doctor checks.
- Doctor's output now includes checks that aren't about PATH.
