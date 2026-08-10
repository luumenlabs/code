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
assets/              Icons and shared art
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

## Running it

```bash
pnpm dev              # the app, with reload
pnpm serve            # the local server on its own, no window
```

The plugin is a separate build; see below. A source checkout will not see a
Studio panel until you have run `luu build` at least once.

## Icons

Both app icons — the blue release one and the purple nightly one — are rendered
from `assets/icon.svg` and `assets/icon-nightly.svg`:

```bash
pnpm assets:icons
```

Output is committed. The build copies the icons into the app, it does not
generate them. Run the app with `LUU_CODE_CHANNEL=nightly` to see the nightly
identity — purple icon, its own taskbar id, and a badge in the title bar.

## Working on the plugin

The plugin is a Luumen project with its own pinned toolchain and tasks in `plugin/.config.luau`.

```bash
cd plugin
luu install        # Rojo, StyLua, Selene, luau-lsp, Lune
luu dev            # rebuild into the Studio plugins folder on every save
luu run check      # stylua, selene, luau-lsp
```

Restart Studio to pick up a new build.

## Releasing

The tag decides the version. Nothing in the repo needs bumping first — CI stamps
every manifest and the plugin's `PLUGIN_VERSION` from the tag, so the app, the
Studio plugin, and the MCP server always ship as one version.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

That runs `.github/workflows/release.yml`: the plugin is built once on Linux,
the app is packaged on Windows, macOS, and Linux, and everything lands in a
draft GitHub release that the last job publishes. Nightlies run themselves from
`nightly.yml` at 05:00 UTC, skip when nothing has changed, and publish as
prereleases on their own update channel.

Packaging locally:

```bash
pnpm --filter @luumen/code-app run package    # installers into packages/app/release/
```

Set `LUU_CODE_CHANNEL=nightly` to build the nightly identity instead — its own
application id, product name, purple icon, and update feed, so it installs
beside a release build rather than over it.

Builds are unsigned. The hooks for signing are in `electron-builder.cjs` and the
workflows; adding `CSC_LINK`/`CSC_KEY_PASSWORD` and the Apple notarization
secrets is all that is needed to turn them on. Until then macOS cannot install
its own updates, and the app says so rather than failing quietly.

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
- `app: name a thread from its first message`

## Pull requests

Include a clear summary, why the change is needed, and what you ran to check it. If your change touches Studio behaviour, say which Studio version you tested against.
