# Using Luu Code from another agent interface

The Roblox integration is not locked to the Electron app. The same operations are available over a local MCP server, so you can keep whatever agent interface you already prefer.

## Setup

**Claude Code**

```bash
claude mcp add luu-code -- luu-code-mcp
```

**Codex** — in `~/.codex/config.toml`:

```toml
[mcp_servers.luu-code]
command = "luu-code-mcp"
args = []
```

**Anything else** that speaks MCP over stdio:

```json
{ "mcpServers": { "luu-code": { "command": "luu-code-mcp", "args": [] } } }
```

`luu-code mcp-config [claude|codex|json]` prints these for your platform.

## How it connects

`luu-code-mcp` attaches to a running Luu Code server if it finds one, and starts its own if it does not. So:

- If the Electron app is open, your external agent shares its Studio connection, output buffer, and permissions.
- If nothing is running, the MCP process becomes the server. The Electron app does not need to be installed or open.

Either way the agent gets the same tools. To run the server without any agent attached — for example to approve a Studio pairing before starting work:

```bash
luu-code serve
luu-code status
luu-code approve <sessionId>
```

## Streamable HTTP

The server also exposes MCP at `http://127.0.0.1:33770/mcp` for clients that prefer HTTP. It requires the local bearer token, which the server writes to `auth.json` in its data directory (`luu-code where`). The endpoint is stateless: one server and transport per request, so a client reconnecting mid-session simply works.

## Working effectively

The tool descriptions carry this guidance, but in short:

1. **Start with `studio_status`.** If Studio is not connected, nothing else will work and the user has to approve the connection in Studio.
2. **Explore progressively.** `studio_services`, then `studio_tree` with a small `maxDepth`, or `studio_search` when you know what you want. Handles from any inspection are the safest way to act on an exact instance later.
3. **Prefer `studio_edit_script` over `studio_write_script`.**
4. **Verify.** An edit succeeding is not evidence the behaviour is right. `studio_mark_output` → change → `studio_start_playtest` → interact → `studio_output` is the loop the product exists for.
5. **Use the right evidence.** A GUI's visibility is a property; its layout is a screenshot. Do not guess from pixels what a property can answer, and do not guess from properties what only rendering can show.
6. **Everything goes through Studio.** Luu Code has no filesystem tools and does not read or write the user's files. If a change belongs in a file on disk, that is your own environment's job, not this server's.

## Realms

During a playtest, `studio_run_state` tells you which DataModel you are observing.

- `mode: "play"` gives a **client**: `LocalPlayer`, `PlayerGui`, the camera, and input all work.
- `mode: "run"` gives a **server**: no player, but server-side state and `ServerStorage` are directly visible.

If `LocalPlayer` is missing, you are almost certainly in `run` mode rather than looking at a broken game.

## Tools

39 tools across seven groups:

| Group | Tools |
|---|---|
| Session | `studio_status`, `studio_capabilities`, `studio_select_session` |
| Inspect | `studio_services`, `studio_inspect`, `studio_children`, `studio_tree`, `studio_search`, `studio_get_properties`, `studio_get_selection` |
| Edit | `studio_set_properties`, `studio_create_instance`, `studio_delete_instance`, `studio_rename_instance`, `studio_move_instance`, `studio_clone_instance`, `studio_set_attributes`, `studio_set_tags`, `studio_set_selection` |
| Scripts | `studio_list_scripts`, `studio_read_script`, `studio_edit_script`, `studio_write_script`, `studio_create_script` |
| Playtest | `studio_run_state`, `studio_start_playtest`, `studio_stop_playtest`, `studio_restart_playtest`, `studio_wait_ready` |
| Observe | `studio_mark_output`, `studio_output`, `studio_clear_output`, `studio_screenshot`, `studio_viewport` |
| Act | `studio_exec`, `studio_press_key`, `studio_type_text`, `studio_mouse`, `studio_click_gui` |
