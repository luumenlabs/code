# Contributing to Luu Code

Thanks for contributing.

## Ways to help

- Improve Roblox Studio support (properties, capabilities, new operations)
- Add support for another coding agent
- Improve the MCP interface
- Improve platform-specific native integration
- Improve interaction and testing reliability
- Fix compatibility with Roblox Studio updates

For anything large, open an issue first so scope and direction can be agreed before implementation.

## Layout

```
packages/protocol/   Shared operation, value, and error definitions
packages/server/     Local server: Studio bridge, permissions, CLI, MCP
packages/app/        Electron harness and agent adapters
plugin/              Roblox Studio plugin (Luau)
docs/                Architecture, protocol, MCP, plugin, security
```

## Prerequisites

- Node.js 20.11+ and pnpm, for the harness
- [Luumen](https://luumen.dev) (`luu`) and Rokit, for the plugin
- Roblox Studio, for anything that touches the plugin

The two halves are independent: you can work on the plugin without the Node toolchain, and on the harness without Studio.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Working on the plugin

The plugin is a Luumen project with its own pinned toolchain and tasks in `plugin/.config.luau`.

```bash
cd plugin
luu install        # Rojo, StyLua, Selene, luau-lsp, Lune
luu dev            # rebuild into the Studio plugins folder on every save
luu run check      # stylua, selene, luau-lsp
```

Restart Studio to pick up a new build. See [docs/plugin.md](docs/plugin.md).

## Adding an operation

Operations are defined once and flow outward from there.

1. Add the entry to `COMMANDS` in `packages/protocol/src/commands.ts`, with its params schema, permission group, capability, and summary.
2. Add its result type to `CommandResults` in the same file.
3. Implement the handler in `plugin/src/Commands/` and register it in `Commands/init.luau`, or handle it server-side in `dispatcher.ts` if it does not belong in Studio.
4. Add a title and, where it helps, a detail line in `packages/server/src/core/activity.ts`, so the user sees Roblox language rather than an op id.
5. Add an MCP tool in `packages/server/src/mcp/tools.ts`. Write the description for an agent that has never seen this project.
6. Add a test.

## Adding a coding agent

Implement `AgentAdapter` in `packages/app/src/main/agents/` and add it to `discovery.ts`. An adapter's whole job is to start the CLI the user already has, point it at the Luu Code MCP server, and translate its output into `AgentEvent`. It must not hold credentials, proxy a model, or make decisions on the agent's behalf.

## Guidelines

- Keep changes focused. Avoid unrelated refactors in the same pull request.
- Fail clearly. Every Roblox-facing failure should carry a code an agent can act on and, where possible, a hint naming what to try instead.
- Do not guess at a target. Ambiguity is an error, not a coin flip.
- Do not report a partial success as a success.
- Probe capabilities rather than assuming them. Studio differs across versions, platforms, and run states.
- Prefer a structured Studio API over desktop automation whenever both would work.
- Keep the surface small. The product is the Roblox Studio connection, not a general local coding environment.

## Tests

```bash
pnpm check        # build, typecheck, test, and the plugin checks
```

Or individually:

```bash
pnpm test
pnpm typecheck
cd plugin && luu run check
```

The server suite runs a simulated Studio plugin through the real transport: pairing, the sync loop, command round trips, and the failure paths. If you change transport or routing behaviour, extend it.

## Commit messages

Describe intent:

- `plugin: read script source through ScriptEditorService`
- `server: route commands by realm instead of recency`
- `docs: explain the Nil tag`

## Pull requests

Include a clear summary, why the change is needed, and what you ran to check it. If your change touches Studio behaviour, say which Studio version you tested against.
