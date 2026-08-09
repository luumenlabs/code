# The Studio plugin

`plugin/` holds the Luau plugin that gives the local server its connection into Roblox Studio.

It is a [Luumen](https://luumen.dev) project. Its toolchain is pinned in `rokit.toml` and its tasks are defined in `.config.luau`, so working on the plugin needs `luu` and nothing from the Node side of the repo.

## Tasks

```bash
cd plugin

luu install        # Rojo, StyLua, Selene, luau-lsp, Lune, via Rokit
luu build          # build straight into the local Studio plugins folder
luu dev            # the same, rebuilt on every save
luu run bundle     # a plain LuuCode.rbxm artifact, for CI and releases
luu format         # stylua
luu lint           # selene
luu run analyze    # luau-lsp
luu run check      # what CI runs
```

`luu build` uses `rojo build --plugin`, which writes into the Studio plugins folder directly on every platform Rojo supports. Restart Studio to pick up a new build.

## Generated inputs

`luu run analyze` runs `scripts/setup.luau` under Lune first. It downloads the Roblox plugin-security type definitions and generates Selene's Roblox standard library if either is missing, then refreshes the Rojo sourcemap.

Neither is committed. Both track Roblox releases, so a stale copy in the repo would quietly report the wrong thing after an engine update.

## Configuration choices

- `luucode.yml` extends Selene's Roblox standard library with `version()`, a Studio global used to report the Studio version so capability differences between releases can be diagnosed.
- `.luaurc` disables the `DeprecatedApi` lint. `version()` and `Plugin:CreateDockWidgetPluginGui` are both marked deprecated but are the only broadly available options; the newer alternatives do not exist on older Studio builds.
- `.config.luau` keeps its commentary in the header block. The `luu` config parser does not accept comments inside the table literal.

## Modules

| | |
|---|---|
| `Client.luau` | Pairing, the two-request sync loop, reconnection |
| `Commands/` | Handlers, one module per area |
| `Handles.luau` | Handle registry, realm epochs, staleness |
| `Path.luau` | Path parsing, resolution, ambiguity detection |
| `Value.luau` | Roblox value encode and decode |
| `Props.luau` | Curated per-class property sets |
| `RunState.luau` | Edit/run detection and realm classification |
| `OutputCapture.luau` | `LogService` and `ScriptContext` capture |
| `Exec.luau` | Luau execution without `loadstring` |
| `InputBridge.luau` | `VirtualInputManager` input |
| `History.luau` | `ChangeHistoryService` recordings |
| `Ui.luau` | The connection panel |

## Notes on Studio behaviour

**HTTP.** Plugin-context `HttpService` requests do not require the place's HTTP setting, which is why this works on an untouched project. Requests only ever go to `127.0.0.1`.

**Realms.** The plugin reports which DataModel it is attached to on every sync. Starting a playtest replaces that DataModel, which is why playtest transitions are orchestrated by the server: the connection that received the request is destroyed by it.

**Play mode.** Studio exposes `RunService:Run()` to plugins but no equivalent for Play. Play is attempted through `VirtualInputManager` and falls back to the desktop shortcut. If neither works, the agent is told to use Run mode rather than being left with a silent no-op.

**Property reflection** does not exist in Luau, so the default property set is curated in `Props.luau`. Contributions there are welcome and low-risk — it is a plain table.

**Execution** creates a `ModuleScript` inside the plugin container and requires it, rather than enabling `LoadStringEnabled` on the user's place. Nothing touches the place.

## Compatibility

Roblox Studio changes often. The connection layer is isolated so that a fix does not require touching the harness, and capabilities are probed and reported rather than assumed. When something becomes unavailable, the goal is that only the affected operation degrades, with a failure that says what to use instead.
