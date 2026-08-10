<div align="center">
  <img src="assets/banner.png" alt="Luu Code" width="680">
</div>

<div align="center">

**Use Claude Code or Codex with Roblox Studio.**

[Download](https://github.com/luumenlabs/code/releases/latest) · [Nightly builds](https://github.com/luumenlabs/code/releases) · [Contributing](CONTRIBUTING.md)

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

## Install

1. **[Download Luu Code](https://github.com/luumenlabs/code/releases/latest)** and run the installer — Windows, macOS, and Linux.
2. From the same release, download **`LuuCode.rbxm`**. In Roblox Studio, open the **Plugins** tab → **Plugins Folder**, drop the file in, and restart Studio.
3. Make sure **Claude Code** or **Codex** is installed and signed in. Luu Code drives whichever you have — it does not ship a model.

### Nightly builds

Nightly builds are published on the [releases page](https://github.com/luumenlabs/code/releases) alongside the stable ones. They carry a purple icon and install beside the release build, so you can keep both.

## Start

1. Open your place in Roblox Studio.
2. Open Luu Code.
3. Studio shows a six-digit code — approve it in the app once the digits match.
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

## Contributing

Building Luu Code from source, adding Roblox operations, and supporting another coding agent are all covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
