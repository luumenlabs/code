<div align="center">
  <img src="assets/banner.png" alt="Luu Code" width="680">
</div>

<div align="center">

**Use Claude Code or Codex with Roblox Studio.**

</div>

---

Luu Code hands your coding agent the keys to your open place. It can read the DataModel, edit scripts, press Play, watch the output, click around the running game, take screenshots, and fix what it broke — while you watch.

You bring Claude Code or Codex. Luu Code brings Studio. There are no credits, no API key, and no AI of its own.

## What the agent can do

| | |
|---|---|
| **Look around** | Services, instance trees, properties, attributes, tags, your selection, script source |
| **Change things** | Create, delete, rename, reparent, clone, set properties, edit scripts |
| **Playtest** | Start and stop Play and Run mode, restart, wait for the game to be ready |
| **Read output** | Everything Studio prints, including the error your last change caused |
| **Poke the game** | Players, characters, PlayerGui, the camera, and Luau it runs live |
| **See the screen** | Screenshots of Studio, handed straight to the agent |
| **Play the game** | Keyboard, mouse, and clicks on real on-screen buttons |

## Before you start

- **Roblox Studio**
- **Claude Code or Codex**, installed and signed in — Luu Code drives whichever you have
- **Node 20.11+ and pnpm**, to build the app
- **[Luumen](https://luumen.dev) (`luu`)**, to build the Studio plugin

## Install

```bash
pnpm install
pnpm build

cd plugin
luu install     # build tools, via Rokit
luu build       # builds straight into your Studio plugins folder
```

Restart Roblox Studio. **Luu Code** appears in the Plugins tab.

## Start

```bash
pnpm dev
```

1. Open your place in Roblox Studio.
2. Studio shows a six-digit code.
3. Approve it in Luu Code — check the digits match.
4. Pick a model, and say what you want changed.

Try:

> The shop errors when I click Buy. Play it, find out why, and fix it.

> Make the lobby spawn brighter, then show me a screenshot.

Chats are saved per place. Open a place and its history is there.

## What it is allowed to do

The chip beside the send button controls the agent's access — looking, editing, playtesting, running Luau, sending input, and screenshots, each on its own switch. Turn any of them off mid-conversation and the agent is told it no longer has them.

Studio only connects after you approve a pairing code, so knowing the port is not enough to reach your place. Everything runs on `127.0.0.1` and nothing is sent anywhere.

Luu Code works through Studio. It does not read or write your files.

## Prefer your own terminal?

The same Roblox tools are available over MCP, so you can skip the app:

```bash
claude mcp add luu-code -- luu-code-mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.luu-code]
command = "luu-code-mcp"
```

It joins a running Luu Code server, or starts one. The app does not have to be open — only Studio.

## Development

```bash
pnpm dev              # the app, with reload
pnpm serve            # the server on its own
pnpm check            # build, typecheck, test, plugin lint
pnpm assets:icons     # re-render the icons from assets/icon.svg

cd plugin
luu dev               # rebuild into the plugins folder on every save
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
