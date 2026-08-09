# Security and privacy

## What an active agent can do

While a session is connected, the coding agent can read and modify scripts in the open place, create and delete instances, start and stop playtests, execute Luau inside Studio, send input to the running game, capture screenshots of the Studio window, and inspect runtime state.

This is stated plainly because it is the product. Luu Code does not hide that the agent has real control over your development environment, and every permission group can be turned off individually in the app or with `luu-code permissions <group> off`.

## Two credentials, because the two sides differ

**Studio** cannot read files, so it earns a token through a pairing code you approve. The plugin displays six digits; you confirm them in Luu Code before any token is issued. Discovering the local port is not enough to drive Studio.

An install id is *not* a credential. Studio's plugin settings are readable by any local process, so a silent reconnect requires the stored token itself — a request that presents only an install id goes back through approval. This is covered by a test.

**Local clients** (the harness, the CLI, MCP) run as you, so they read a token from a user-only file (`auth.json`, mode `0600`) in the data directory. A process that cannot read your files cannot issue commands.

The listener binds to `127.0.0.1`. Remote access is not a configuration option; enabling it would turn a local trust decision into a network one.

## Safety boundaries

- Operations are scoped to the connected Studio session; commands cannot cross into another Studio window.
- Stale instance references fail with `TARGET_STALE`, and handles from a different edit/run realm fail with `WRONG_REALM`, rather than acting on whatever now occupies that path.
- An ambiguous path fails with the candidates instead of picking one.
- Every mutation runs inside a `ChangeHistoryService` recording, so Ctrl+Z in Studio reverses the agent's work like any other edit. A failed edit is rolled back rather than left half-applied.
- A property write where *every* property was rejected is reported as a failure, not a partial success — reporting it as ok would let an agent believe an edit landed.
- Input requires a running playtest, and a GUI click that lands on a hidden or zero-size element fails with the reason instead of reporting a click that did nothing.
- Luu Code does not attempt to bypass Roblox Studio's security restrictions.

## Running Luau in Studio

`runtime.exec` compiles by creating a `ModuleScript` inside the plugin's own container and requiring it. Nothing is added to your place, nothing replicates, and nothing lands in the undo history.

The alternative — enabling `LoadStringEnabled` — would quietly change a setting on your project, so it is not used.

Executed code runs at plugin security in whichever DataModel is currently connected. It is a powerful capability, gated by the `exec` permission group and visible in the activity log like everything else.

## The filesystem

Luu Code does not read or write your files. Every capability it exposes goes through Roblox Studio, and there is no tool in the surface that opens a path.

A coding agent still runs as a child process and needs a working directory, so it gets a scratch folder of its own per place under Luu Code's data directory. Anything an agent writes on a whim lands there rather than among your projects. Whatever filesystem tools that agent brings of its own remain its business and are governed by its own permissions, not by Luu Code.

## Privacy

Core functionality is local. Your place, source, screenshots, runtime state, and observations are not uploaded to any Luumen service, and there is no such service in the path.

Data does reach the model provider behind whichever coding agent you chose, when it is included in the agent's session. That relationship is between you and that provider. Luu Code holds no model credentials and adds no telemetry around source, screenshots, prompts, or project contents.

Local state lives in one directory (`luu-code where`):

```
settings.json   port, permissions, approved pairings
auth.json       the local client token (0600)
screenshots/    scratch space, deleted after each capture
threads/        one JSON file per conversation
workspaces/     a scratch working directory per place, for agent processes
```
