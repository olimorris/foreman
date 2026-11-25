# 6. Foreman reaches the user on Telegram only through Claude Code's official Telegram plugin, loaded by the orchestrator alone

Everything goes through Claude, so replies from Telegram reach the orchestrator as the user's own words. Only one session can own the bot at a time, so workers and the reviewer never load the plugin. Rejected: calling Telegram's bot API directly, which can send but can't carry the user's replies back into the session.
