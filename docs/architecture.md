# Architecture

Four pieces, one connection.

```
  Claude Code / Codex                    Any MCP-capable agent
          │                                        │
          │ stdio (stream-json / exec --json)      │ MCP (stdio or HTTP)
          ▼                                        ▼
  ┌───────────────────┐                  ┌──────────────────────┐
  │  Electron harness │◄── IPC / SSE ───►│  luu-code-mcp        │
  └─────────┬─────────┘                  └──────────┬───────────┘
            │                                       │
            │            127.0.0.1                  │
            └──────────────► Local server ◄─────────┘
                                  │
                                  │ long-polled HTTP
                                  ▼
                        Roblox Studio plugin (Luau)
                                  │
                                  ▼
                            The open place
```

## The local server

Everything funnels through one dispatcher (`packages/server/src/core/dispatcher.ts`): validation, permission checks, capability gating, routing, and the activity log. The harness and an external MCP client take the same path, so an external agent is not a second-class client and cannot end up with different behaviour from the first-party app.

The server binds to loopback only. Remote access is not a setting.

## Talking to Studio

Studio plugins cannot open sockets, so the plugin drives everything with HTTP requests to `127.0.0.1`. Plugin-context requests do not require the place's HTTP setting to be enabled, which is why this works on an untouched project.

After pairing, the plugin runs **two** concurrent requests:

- a **poll** that the server parks until it has a command, so a command reaches Studio the moment an agent issues one;
- a **push** that fires whenever results, output, or a run-state change are waiting.

Splitting them matters. With a single loop, a result produced while a poll was parked would sit unsent until the poll expired, and every agent call would inherit that delay.

## Realms

Studio does not hand the plugin one stable DataModel.

| Studio state | What the plugin is attached to |
|---|---|
| Edit | the edit DataModel |
| Run (F8) | a server DataModel, no player |
| Play (F5) | a client DataModel, with `LocalPlayer` |

A single Studio window can therefore have more than one live plugin connection, so commands are routed to an **endpoint** rather than to a session. Endpoint selection is deterministic (`selectEndpoint` in the protocol package) rather than "most recent", which would flap between two long-polling connections.

Every result carries the realm it was produced in. An agent that cannot find `PlayerGui` is told it is looking at the server DataModel, instead of concluding the GUI does not exist.

## Handles and staleness

Inspection returns a handle (`@h42`) alongside a path. Handles are stamped with a realm epoch that increments on every edit/run transition, so a handle captured during a playtest can never be replayed against an edit-time instance — it fails with `WRONG_REALM` instead.

Paths are resolved fresh on every call, which is what makes them safe while the user is editing Studio at the same time. A path that matches more than one child fails with `TARGET_AMBIGUOUS` and the candidate handles, rather than silently picking one.

## Playtest transitions

Starting or stopping a playtest destroys the DataModel that received the request, so the command usually cannot report its own outcome. `run.start`, `run.stop`, and `run.restart` are therefore executed by the **server**: it fires the request, then watches the run state arriving on whichever connection comes back.

Studio exposes Run to plugins but not Play. Play is attempted in-Studio first and falls back to the desktop shortcut, which is the only remaining path. If neither works, the agent is told to use Run mode rather than being left with a silent no-op.

## Native integration

The native layer exists only for the things Studio cannot do:

- **Screenshots**, because no plugin API can read the viewport. The Electron app captures through the compositor (no focus stealing); the server falls back to a platform helper so headless MCP use still works.
- **Pressing Play**, as described above.

When a structured Studio API can do the job, it is preferred. Game interaction goes through `VirtualInputManager` inside the running experience, not through the desktop.

## What the harness adds

The MCP path is deliberately not crippled. The harness earns its place by owning both ends:

- screenshots appear in the conversation, because the server attaches them to the activity stream
- Roblox operations render in Roblox language rather than as tool identifiers
- runtime errors surface without the user copying anything
- connection, permission, and playtest controls live next to the conversation
