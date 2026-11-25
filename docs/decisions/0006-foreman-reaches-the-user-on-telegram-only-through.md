# ADR-0006: Foreman reaches the user on Telegram only through Claude Code's official Telegram plugin, loaded by the orchestrator alone

## Status

Accepted

## Date

2026-11-25

## Context

The user wants Foreman to ping them on Telegram, and wants everything to go through Claude. Only one session can own a Telegram bot at a time: a second session that loads the plugin loses its connection.

## Decision

Foreman reaches the user on Telegram only through Claude Code's official Telegram plugin, loaded by the orchestrator alone. A `telegram.when` setting in free text says when to ping.

## Alternatives Considered

### Call Telegram's bot API directly

- Pros: Works without channels, one-way.
- Cons: The user's replies can't reach the session.
- Rejected: Everything must go through Claude.

## Consequences

- Replies from Telegram reach the orchestrator as the user's own words.
- Workers and the reviewer never load the plugin, so they can't take the bot.
- It depends on the user's org allowing Claude Code channels.
