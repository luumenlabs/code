# Luu Code

**Use Claude Code or Codex with Roblox Studio.**

Luu Code is an open-source Roblox Studio harness for coding agents. It gives the agent you already use the ability to inspect and edit your place, run it, watch what happens, interact with it, and check its own work.

It is not another AI Roblox builder. There are no credits to buy, no model API key to provide, and no proprietary agent inside it. You bring Claude Code or Codex; Luu Code brings Roblox Studio.

---

## Why

Coding agents are good at editing files and blind to everything else about a Roblox project.

Most of a Roblox game does not exist on disk at all. The DataModel, script sources, GUI layout, and runtime state live inside Studio, where an agent that only reads files cannot reach them.

So a coding agent can describe a change but not make it, and certainly not check it: it cannot press Play, read the error that appeared, click the button it just wired up, or tell whether any of it worked.

Luu Code gives it the Studio connection that closes that gap. It works through Studio only — it does not read or write your files.

## What the agent can do

| | |
|---|---|
| **Inspect** | Services, instance trees, properties, attributes, tags, selection, script source |
| **Edit** | Create, delete, rename, reparent, clone, set properties, targeted script edits |
| **Playtest** | Start and stop Play or Run mode, wait for the session to be ready, restart |
| **Observe** | Studio output with cursors, so "what did *my* change break" is answerable |
| **Runtime** | Live players, characters, PlayerGui, camera, and arbitrary Luau evaluation |
| **See** | Screenshots of the Studio window, passed straight into multimodal agents |
| **Interact** | Keyboard, mouse, and GUI clicks resolved to real on-screen elements |

Every operation reports what it actually changed, or fails with a code the agent can act on.

## Install

The harness is a pnpm + Turborepo workspace. The Studio plugin is a [Luumen](https://luumen.dev) project, so it is built with `luu`.

```bash
pnpm install
pnpm build

cd plugin
luu install     # Rojo, StyLua, Selene, luau-lsp, Lune, via Rokit (build tooling only)
luu build       # builds straight into your Studio plugins folder
```

Then restart Roblox Studio. The Luu Code panel appears in the Plugins tab.

While working on the plugin, `luu dev` rebuilds into the plugins folder on every save.

### First run

1. Open your place in Roblox Studio.
2. Start Luu Code (`pnpm dev`) or the server alone (`pnpm serve`).
3. Studio shows a six-digit code. Approve it in Luu Code.
4. Pick Claude Code or Codex, and describe what you want changed.

The pairing step exists so that discovering the local port is not enough to control your Studio session. See [docs/security.md](docs/security.md).

## Using it from another agent interface

Luu Code exposes the same Roblox capabilities over a local MCP server, so you can keep whatever agent interface you already prefer:

```bash
claude mcp add luu-code -- luu-code-mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.luu-code]
command = "luu-code-mcp"
```

It attaches to a running Luu Code server if there is one, and starts its own if not. The Electron app does not need to be open. See [docs/mcp.md](docs/mcp.md).

## Conversations belong to a place

A chat is filed against the Roblox place it is about, not a folder on disk. Open a place, and its past conversations are there; connect a different place, and you get that one's.

Studio has to be connected before a conversation can start, because otherwise there is nowhere to file it.

## Layout

```
packages/protocol/   Shared operation, value, and error definitions
packages/server/     Local server: Studio bridge, permissions, CLI, MCP
packages/app/        Electron harness and agent adapters
plugin/              Roblox Studio plugin (Luau)
docs/                Architecture, protocol, MCP, plugin, security
```

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit and why
- [Protocol](docs/protocol.md) — operations, values, targets, errors
- [MCP setup](docs/mcp.md) — connecting an external agent
- [Studio plugin](docs/plugin.md) — building, installing, capabilities
- [Security and privacy](docs/security.md) — trust model and what stays local

## Development

```bash
pnpm build            # protocol, server, app, through Turborepo
pnpm test             # protocol and server test suites
pnpm typecheck
pnpm check            # all of the above, plus the plugin checks

cd plugin
luu run check         # stylua, selene, luau-lsp
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The Studio connection layer is deliberately isolated so that Roblox changes can be absorbed without touching the harness.

## License

MIT. See [LICENSE](LICENSE).
