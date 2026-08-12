# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)**. It is the whole thing: layout, commands, how the
pieces fit, how to add an operation, house style, and the gotchas worth knowing
before they cost an hour.

It is one file rather than two because this repo's entire design is about copies
not drifting apart — the app, the Studio plugin, and the MCP server ship from one
release for exactly that reason. Two sets of instructions for two agents would be
the same mistake in the documentation.

Claude Code is also one of the two CLIs Luu Code drives, alongside Codex. When you
change how an agent session is started, streamed, or interrupted, check both
adapters in `packages/app/src/main/agents/` — they behave differently, and Codex
is the one more easily forgotten. Ollama rides on the Codex adapter, so a change
there lands on local models too.
