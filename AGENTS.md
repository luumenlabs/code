# Luu Code — notes for coding agents

Luu Code hands an existing coding agent the keys to an open Roblox Studio place:
read the DataModel, edit scripts, press Play, read the output, click around the
running game, take screenshots. It drives **Claude Code** or **Codex** — whichever
the user already has installed and signed in — or a model from their own
**Ollama**. It ships no model, holds no API key, and never asks for one.

Everything runs on `127.0.0.1`. Nothing leaves the machine.

## Layout

| Path | What it is |
|---|---|
| `packages/protocol` | Shared types. `commands.ts` is the single source of truth for every Roblox operation: params schema, permission group, capability, summary. |
| `packages/server` | The local server (default `127.0.0.1:33770`): Studio bridge, permissions, dispatcher, and the MCP interface. Also the `luu-code` / `luu-code-mcp` CLIs. |
| `packages/app` | Electron. `src/main` (agent sessions, threads, settings, updater, plugin installer), `src/renderer` (React + Tailwind + Radix), `src/shared` (the IPC contract and types both sides use). |
| `plugin/` | The Luau Studio plugin. Its own Luumen project driven by `luu`, toolchain pinned in `rokit.toml`. Needs none of the Node toolchain. |

The two halves are independent: you can work on the plugin without Node, and on
the harness without Studio.

Two pairs of files are the two ends of one thing, and neither half makes sense
alone:

- `packages/protocol/src/changes.ts` and `plugin/src/Changes.luau` — see
  [The change journal](#the-change-journal).
- `packages/app/src/renderer/styles.css` and `plugin/src/Theme.luau`. The plugin
  panel is docked into Studio while the app sits beside it, so the two are on
  screen together and have to look like one product. `Theme.luau` is the app's
  custom properties converted from oklch to sRGB, written out rather than
  matched by eye. Change a colour in the stylesheet and convert it there too;
  nearly-the-same reads as a bug in a way that plainly-different does not.

## Commands

```bash
pnpm install
pnpm check            # build, typecheck, test, and the plugin checks
pnpm dev              # the app, with reload
pnpm serve            # the local server alone, no window

cd plugin
luu install           # Rojo, StyLua, Selene, luau-lsp, Lune
luu dev               # rebuild into the Studio plugins folder on every save
luu run check         # stylua, selene, luau-lsp
```

Tests are vitest, in `packages/protocol` and `packages/server`.

## How the pieces fit

Studio pairs with the server by six-digit code, then polls it. The app starts the
user's CLI and points it at the Luu Code **MCP server**, so the agent reaches
Roblox through the same tools an external terminal would. Every operation flows
`agent → MCP → dispatcher → plugin → Studio`, and back as an `ActivityEvent` the
transcript renders in Roblox language rather than tool ids.

Which model the user picks decides which CLI runs — there is no separate agent
picker. Codex models are discovered live from `codex app-server`; Claude models
are declared in `src/shared/models.ts` and gated on the installed CLI version.

**Ollama is a provider, not a third CLI.** Its models are discovered from the
daemon's own `/api/tags` — which models exist is a fact about the machine — and
the session is run by the Codex CLI pointed at Ollama with
`-c model_provider='ollama'`, so it is `CodexAdapter` with a different
`CodexVariant` rather than an adapter of its own. Writing a real Ollama adapter
would mean this app running its own tool loop, which is the line the harness
does not cross. Two consequences worth knowing: Ollama needs the Codex CLI
installed (`AgentInfo.command` for it *is* Codex's path), and a model that
cannot call tools is left out of the catalogue, because every single thing an
agent does here is a tool call. See `src/main/agents/ollama.ts`.

**One agent session per chat, all running at once.** `AgentManager` keys sessions
by thread id, and every agent event carries the thread it came from. Opening a
chat is a change of view and stops nothing. Because they share one server, each
session's MCP child is given `LUU_CODE_CHAT`, which comes back on
`ActivityEvent.chat` and is how a Roblox operation is filed against the chat that
asked for it rather than the one on screen.

**A chat is bound to one Studio window.** Several windows can be connected at
once, so `LUU_CODE_CHAT` also decides where an operation is *sent*, not only
where it is filed. A chat is pinned to a window by the first command it issues
and stays there — including across a Studio restart, which `findSuccessor`
recognises by install id — until `session.select` moves it. A caller with no chat
falls back to `activeSessionId`. The pinning matters because chats run
concurrently: a single moving target would let one chat's edits land in whichever
place the user last clicked, and nothing in the transcript would say so.

Identity comes in two halves. The **install id** is the game, derived by the
plugin from the place identity, and is what a pairing approval is remembered
against — so two windows on one place share a credential, and the second connects
without asking. The **window id** is the Studio window, generated per plugin
runtime and never persisted. `SessionRegistry` keys sessions by window and
credentials by install.

Underneath both is the **place identity**, `placeIdentity()` in
`plugin/src/Client.luau`: `place:<PlaceId>`, or `game:<GameId>` for a place that
belongs to a universe but has never been published, or nothing. Everything
durable keys on it — the stored credential, the sidebar's grouping, the
successor lookup after a Studio restart. **A name is never part of it.** Two
places called Baseplate are two places, and a fallback to the name merged their
histories the one time it existed. A place with no identity is filed under
Unknown, which is the honest answer rather than a heading claiming they are one
game.

The **name** is presentation only, and it is not the name on the Studio tab.
Studio's tab shows the file the place was opened from and exposes it to no
plugin API; `game.Name` is the DataModel's own name, which Studio never updates,
so a place made with File → New stays "Place1" whatever it is later saved as.
The plugin resolves the published name from `MarketplaceService` after the
handshake — off that path, because a Roblox round trip is not worth delaying a
connection for — and rides it up on the next sync. `SessionRegistry.applyPlace`
accepts a redescription only when the identity matches, so a session can never
change which game it stands for without reconnecting.

## Playtesting, input, and capture

All three go through a structured Studio API. Nothing here may drive the user's
desktop.

**Playtests are `StudioTestService`.** Two properties shape everything above it:

- The `Execute*` calls **yield for the whole life of the session**, so `RunOps`
  spawns them and the run state reports the outcome.
- **Starting and stopping are different peers** — only edit can start, only a
  running one can end. `RunControl` picks the peer through
  `SessionRegistry.findPeer`, which is why `sessions.send` takes a `peer`. A
  request aimed at a named peer never rebinds the chat: a playtest's connection
  is transient and would strand it when the playtest ends.

**Input is `UserInputService:CreateVirtualInput()`.** Capability is probed by
*constructing* the object.

**Capture is `CaptureService` plus `EditableImage`**, encoded to PNG by
`core/png.ts` because Luau has no deflate. The desktop paths in
`native/screenshot.ts` answer `source: "window"` and `"screen"` only, and nothing
falls back to them silently.

## Diagnostics

Four operations answer questions the DataModel cannot, and each is shaped by
what Roblox will and will not expose to a plugin.

**Every script write is compiled.** `script.set`, `script.patch`, and
`script.create` return a `syntax` check, produced by `Exec.check` wrapping the
source in `return function(...) ... end` and requiring it: the whole chunk is
compiled and only the `return` runs, so the body is never executed. The wrapper
costs one line, which is why the reported line number is decremented. The write
still happens when it fails — a script that does not compile yet is a normal
state to be halfway through — but the activity row says so, and so does the
result. `syntax` is null, not false, where the plugin cannot compile at all.

**`debug.breakpoints` never pauses.** `ContinueExecution` is always true and a
`set` without a `log` is refused. A stopping breakpoint needs a
`ScriptDebuggerService.OnStopped` handler to resume it, and with none installed
the playtest stops with both peers unreachable — so that kind is not offered
rather than offered with a warning. Only breakpoints Luu Code set are removed by
`clear`; the user's own are theirs. The capability is probed by setting one on a
throwaway ModuleScript and taking it back, because the debugger API is behind a
Studio beta and a build without it still hands over the service.

**`dm.class_info` is a probe, not a dump.** Roblox exposes no property
reflection to Luau, so the class is described by creating one instance and
reading each member — the curated set from `Props.luau`, plus whatever names the
caller passed. `writable` is established by writing the value just read back to
itself, which is why it is null for a service: that instance is the user's.
`FindService` rather than `GetService`, because `GetService` would insert a
service the place does not have, and describing a class is a read.

**`perf.script` needs a running peer**, and the run state cannot be used to
decide that. A session's run state is its primary endpoint's, and during a
playtest that is the edit peer, which is not itself running — so the capability
says only whether the build can profile, and the peer that receives the request
raises `PLAYTEST_NOT_RUNNING`. Same reasoning applies to anything else tempted
to gate on run state at the server.

## Project rules

A place carries its own instructions for agents, as a ModuleScript at
`TestService.AGENTS`. There is no working tree to keep an AGENTS.md in, so the
document lives in the DataModel: it saves into the place file, syncs over Team
Create, and round-trips through Rojo, which is what makes a rule written once
reach everyone who opens the game.

The path is fixed and nothing is searched for. A script named AGENTS elsewhere
in the tree is the user's own. TestService hosts it because nothing else puts
anything there and nothing under it replicates to a player.

Three things about it are load-bearing:

- **The document is a ModuleScript, so its source has to compile.** The text is
  stored wrapped as `return [==[ ... ]==]`, put on and taken off by
  `wrapRules`/`unwrapRules` in `packages/protocol/src/rules.ts`. Raw markdown
  there would be flagged by Studio's Script Analysis and would fail the syntax
  check every write returns. Source that is not wrapped is read as it stands,
  so a hand-written document still works.
- **`rules.get` uses `FindService`, `rules.set` uses `GetService`.** Reading is a
  read, and `GetService` would insert a TestService into a place that does not
  have one. A non-ModuleScript holding the name comes back as `conflict` rather
  than as no rules, and refuses the write rather than creating a sibling.
- **The rules are read once, when a session starts.** `briefingFor` composes
  them into the harness briefing for both adapters; `SessionOptions.projectRules`
  is a callback so reusing a live session costs no Studio round trip. A session
  already running keeps the text it opened with, and an edit reaches the next
  one.

## Adding an operation

Operations are defined once and flow outward.

1. Add it to `COMMANDS` in `packages/protocol/src/commands.ts`.
2. Add its result type to `CommandResults` in the same file.
3. Name it in `TOOL_NAMES`, also in that file. The `satisfies Record<Op, ...>` is
   exhaustive, so this is not optional — an op with no entry fails the build.
   `null` means machinery rather than a tool an agent calls.
4. Implement it in `plugin/src/Commands/` and register it in `Commands/init.luau` —
   or handle it server-side in `dispatcher.ts` if it does not belong in Studio.
5. Give it a title in `packages/server/src/core/activity.ts`, so the user sees
   Roblox language.
6. Describe it in `packages/server/src/mcp/tools.ts`. Write for an agent that has
   never seen this project. A named op with no description fails a test.
7. Add a test.

The permission group in step 1 is also where the operation appears in the user's
controls, so pick it by what the operation lets an agent *do*.

## Permissions

Six groups, with every operation under them switchable on its own.
`packages/protocol/src/policy.ts` holds the logic;
`Dispatcher.checkPermission` is the only place it is enforced. Four rules:

- **A group that is off turns off everything inside it.** No per-tool switch
  overrides that.
- **Only the exceptions are stored**, so a new tool needs no migration and cannot
  arrive disabled. Unknown ids are kept rather than dropped — usually a tool from
  a build the user rolled back from.
- **`ESSENTIAL_OPS` stay on.** They are how an agent reports what is wrong.
- **A disabled tool is hidden from the MCP list, not offered and refused.** The
  server declares `tools.listChanged` and fires it from the `capabilities` bus
  event, which is why changes go through `LuuCodeServer.setPermission` and
  `setToolAllowed` rather than the settings store: every MCP child is a separate
  process holding a list it fetched at connect time.

**If it mutates, it also has to say what it changed.** Return a `changes` array
of drafts built by `plugin/src/Changes.luau` — see below. An operation that
edits the place without one is invisible to review and cannot be taken back.

## The change journal

The user can read what was done to the DataModel and put any of it back. There
is no working tree to diff, so this is a record of individual mutations rather
than a file history.

`plugin/src/Changes.luau` builds a draft per mutation, holding both sides of the
write, and takes a copy of anything destroyed so a delete can be undone. Drafts
ride back on the command result. `packages/server/src/core/changes.ts` strips
them off before the result reaches the agent, stamps them with the chat and the
activity they came from, and keeps them per Studio window. The app reads them
through `changes.list` and puts them back through `changes.revert`, which hands
the records to `changes.apply` in Studio.

Four things about it are load-bearing:

- **The records never reach the agent.** `takeChanges` removes them in the
  dispatcher. The old source of a script the agent just rewrote is the largest
  thing this protocol can carry, and returning it would double the cost of every
  write to tell the model something it already knows.
- **`after` is recorded as carefully as `before`.** Nothing stops the user
  editing the same instance a second later. A revert compares what is in the
  place now against what the change left behind and refuses anything that has
  moved on since, unless the user asks again with `force`. That refusal is the
  feature, not an obstacle to work around.
- **Revertible means revertible.** A property Roblox would not read, an instance
  with `Archivable` off, a script too large to keep a copy of — each is recorded
  with `revertable: false` and a reason the panel shows instead of a button.
  Bounds are applied when the copy is taken, never by evicting one later: a row
  that says it can be put back has to stay true.
- **It is in memory, and per window.** Records only mean anything next to the
  live DataModel they describe. Disconnecting a window drops its history, and an
  edit/run transition releases the held copies, because an edit-time instance
  must not be restored into a running world.
- **The diff outlives the journal, in a second copy.** Reverting needs a live
  place; reading does not, and a transcript that keeps "Changed the source of
  Shop" and throws away the diff has kept the wrong half. So the app archives
  records against the conversation that asked for them — `Thread.changes`,
  written by `ThreadStore.recordChanges`, bounded by count and by bytes. A
  record the live journal no longer holds renders identically and offers no
  Revert. The duplication is the design; do not collapse it.

Reverting is not `Ctrl+Z`. Studio's undo stack is linear and shared with the
user's own edits; "take back that one thing the agent did an hour ago" is not a
question a stack can answer. Both exist: every mutation still runs inside a
`ChangeHistoryService` recording.

Three files in `packages/app/src/renderer/components` turn a record into a diff:
`changeDocument.ts` writes the mutation out as the two versions of a Luau file
and counts the lines that moved, `ChangeDiff.tsx` hands that pair to
`@pierre/diffs`, and `Changes.tsx` is the row. Three things there are easy to
undo by accident:

- **The theme is borrowed for token colours only.** Every surface, both diff
  colours, and the type are bound to the app's own CSS variables through the
  library's `unsafe` layer. A bundled theme is a whole palette, and it is not
  this one.
- **A row is a filename and `+12 −3`,** not `record.summary`. The plugin's
  sentence is the right thing to hand an agent and to copy out; it is the wrong
  thing to stack forty of down a panel, so it lives on the row's title and in
  the viewer's header.
- **Nothing folds a turn's diffs away.** `TurnChanges` sits at the top level of
  the turn, outside the working-out fold and the run folds, because those exist
  to keep scrollback readable and none of them should be able to hide the part
  the user is being asked to approve. Opening one replaces the chat column
  rather than floating a modal over it.

## House style

**Comments are short.** One or two lines. They explain **why** — the constraint
that made the obvious approach wrong, the failure being defended against — and
only where the next person would otherwise undo the code. Do not argue a case, do
not compare the approach to the one not taken, do not narrate what the next line
plainly does. A paragraph justifying a decision is a paragraph nobody reads.
Match the density of the file you are editing.

**User-facing text is shorter.** Labels, descriptions, tooltips, and errors say
what the thing is or what to do next. They never explain a reason, a trade-off,
or how anything works underneath. "Always on — this is how an agent reports what
is wrong" is already at the limit; anything longer belongs nowhere.

**Documentation describes what is, not what was considered.** No rationale for
picking a library, no defence of an architecture, no history. Say how the thing
behaves and what will break if you change it.

- Fail clearly. Every Roblox-facing failure carries a code an agent can act on and,
  where possible, a hint naming what to try instead.
- Never report a partial success as a success.
- Do not guess at a target. Ambiguity is an error, not a coin flip.
- Probe capabilities rather than assuming them; Studio differs by version, platform,
  and run state.
- Prefer a structured Studio API over desktop automation when both would work.
- Keep the surface small. The product is the Studio connection, not a general local
  coding environment.

## Channels

Three identities, decided at runtime, each with its own icon, window title, taskbar
id, app state directory, and Studio plugin file:

| | Release | Nightly | Dev (`pnpm dev`) |
|---|---|---|---|
| Icon | blue | purple | amber |
| Plugin file | `LuuCode.rbxm` | `LuuCodeNightly.rbxm` | `LuuCodeDev.rbxm` |

A build only ever updates from its own channel; the feed is baked in at package
time. A dev build keeps separate chats and settings, so working on the app never
touches the history of the installed one. `LUU_CODE_CHANNEL` overrides.

Releasing is covered in [CONTRIBUTING.md](CONTRIBUTING.md): push a `v0.0.0` tag and
the workflow does the rest.

## Gotchas

These are all real, and all cost time when hit blind.

- **`git checkout` on a `.luau` file breaks stylua.** `core.autocrlf` rewrites it
  CRLF; `plugin/.stylua.toml` sets `line_endings = "Unix"`, so `luu run check`
  then fails on a file you did not mean to change. Normalise back to LF.
- **`ELECTRON_RUN_AS_NODE` leaks from Electron-hosted terminals.** Left set, the
  Electron binary starts as plain Node and dies confusingly — the app looks like
  it crashes instantly. `dev.mjs` and `render-icons.mjs` delete it; do the same in
  any new launcher, and unset it before smoke-testing a packaged build.
- **The Claude Agent SDK must be told which `claude` to run.** Left to itself it
  resolves the CLI it ships as an optional dependency, relative to its own module
  URL — which after bundling is `dist/main/main.cjs`, where pnpm has linked the
  SDK but never its platform packages. The binary is on disk and unreachable, and
  the app reports "Native CLI binary for win32-x64 not found" while the user has a
  working `claude` on PATH. `pathToClaudeCodeExecutable` is set from discovery for
  exactly this reason. It must be a real executable: the SDK spawns it with no
  shell and, on Windows, no PATHEXT lookup, so a bare `claude` never resolves and
  an npm `claude.cmd` fails with `spawn EINVAL`. See `agents/claudeExecutable.ts`.
- **`VirtualInputManager` cannot be called from a plugin, and fails in the worst
  possible way.** Every one of its `Send*Event` methods is RobloxScriptSecurity,
  so a plugin raises on each. The service itself is fetchable, which is what made
  this cost months: `isAvailable` asked whether `GetService` worked, said yes,
  and Luu Code advertised `input.virtual`, accepted every key and click, and
  delivered none of them. `UserInputService:CreateVirtualInput()` is the callable
  path. Probe any capability by doing the thing, never by naming the API.
- **A minimized Studio window keeps running scripts but stops rendering *and*
  processing input.** Heartbeat carries on at full rate, so it is useless as a
  signal; `RenderStepped` is what stops. `RenderMonitor` watches frame freshness
  for exactly this, because without it synthetic input returns success having
  done nothing and `CaptureService:CaptureScreenshot` never calls its callback at
  all — it does not fail, it simply never answers.
- **`AssetService:CreateEditableImageAsync` needs the place's Mesh/Image API
  permission.** Without it, viewport capture fails at the read step, after the
  screenshot has already been taken. The error names the Game Settings switch;
  keep it that way, because nothing else about the failure suggests a setting.
- **`plugin:SetSetting` is one store for the whole machine.** Not per window, not
  per place. Every open Studio reads back the same value, so nothing persisted
  there can identify a window — that is why the install id is scoped by place
  identity and the window id is generated per plugin runtime instead of stored.
  A place with no durable identity gets no persisted credential at all and pairs
  again each launch, which is the honest answer for a place Luu Code cannot
  recognise twice. Test doubles must mint their own window ids; giving them all
  one is how this went unnoticed.
- **Output has to be seeded from `LogService:GetLogHistory()`.** A runtime peer's
  plugin loads after the place's own scripts have started, so everything printed
  up to that point — which is where a startup error lives — exists only in
  Studio's Output window. `OutputCapture.start` adopts the tail of the history
  before connecting `MessageOut`, and holds the messages it took for two seconds
  so the deferred ones do not arrive twice.
- **An operation that watches for a span needs a timeout to match.** `timeoutFor`
  adds `durationMs` to the budget for exactly this: a thirty-second measurement
  was otherwise abandoned at fifteen, and the failure named Studio rather than
  the duration the caller chose.
- **The renderer only runs under Electron.** There is no browser mock bridge; a
  bare `vite` serve renders nothing.
- **Do not stop an agent when the user switches chat.** It used to, and the stop
  was not honest: the state went to `stopped` while the CLI was still draining
  its stream, so a chat that was very much still working looked finished and its
  remaining output was recorded against whichever chat had just been opened.
  Anything that ends a session has to be something the user asked for — deleting
  the chat, interrupting it, or switching to the other CLI.
- **Ports belong to the user.** `33770` (server) and `5273` (renderer) are probably
  their running `pnpm dev`. Do not kill them; use `LUU_CODE_PORT` and
  `LUU_CODE_HOME` for an isolated run.
- **`plugin/` has no `.rbxm` until you build one.** A fresh clone cannot install a
  plugin from the app until `luu run bundle` has run.
- **A plugin module cannot be named after a property of `Script`.** Every module
  is reached as `script.Parent.<Name>`, `script.Parent` is a `LuaSourceContainer`,
  and Roblox resolves properties before children — so a module called `Source`
  is never found. The index hands back the parent script's own text and `require`
  fails on a string, quoting the whole of `init.server.luau` back at you and
  naming neither file. `ScriptSource.luau` is called that for this reason.
  Nothing catches it: stylua, selene, and luau-lsp all pass, because to them the
  property access is perfectly valid. The same trap is waiting for `Name`,
  `Parent`, `Archivable`, `ClassName`, `Enabled`, `Capabilities`, and
  `RunContext`.
