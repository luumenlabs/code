# Protocol

The operation surface is defined once, in `packages/protocol/src/commands.ts`, and drives server validation, permission and capability gating, MCP tool generation, and the harness activity log.

## Targets

Every operation names its target with a single string:

```
@h42                          a handle returned by an earlier inspection
game.Workspace.Baseplate      a path from the DataModel root
Workspace.Baseplate           the leading "game." is optional
Workspace["My Part"].Handle   bracket form for names with dots or spaces
```

Handles are exact and fail loudly once the instance is gone. Paths are resolved fresh on every call, which is what makes them safe to use while the user is editing Studio at the same time.

A path matching more than one child is an error, not a coin flip:

```json
{
  "code": "TARGET_AMBIGUOUS",
  "message": "3 instances named \"Button\" exist under game.StarterGui.Shop",
  "details": { "candidates": [ { "handle": "@h12", "path": "..." } ] },
  "hint": "Use one of the returned handles instead of the path."
}
```

## Values

Primitives are plain JSON. Everything else is tagged with `$t` and mirrors the Roblox constructor, so a value that was read can be written back unchanged:

```json
{ "$t": "Vector3", "x": 0, "y": 5, "z": 0 }
{ "$t": "UDim2", "x": { "scale": 0.5, "offset": 0 }, "y": { "scale": 0, "offset": 40 } }
{ "$t": "Color3", "r": 1, "g": 0.53, "b": 0, "hex": "#FF8800" }
{ "$t": "Enum", "enum": "Material", "name": "Neon", "value": 288 }
{ "$t": "Instance", "ref": "@h12", "path": "game.Workspace.Part", "className": "Part" }
{ "$t": "CFrame", "position": [0, 5, 0], "orientation": [0, 90, 0] }
```

Two shapes exist for values that JSON cannot carry:

- `{ "$t": "Opaque", "typeName": "...", "text": "..." }` — readable, not writable. Also used for `NaN` and infinities, which JSON has no form for.
- `{ "$t": "Nil" }` — an explicit nil. Roblox's JSON decoder **drops** keys whose value is `null`, so `{"Owner": null}` would arrive in Studio as an empty table and "remove this attribute" would silently do nothing. The server rewrites outbound nulls into this tag and rewrites the tag back to `null` on the way out, so agents only ever see plain JSON.

## Reads report what they could not read

`dm.get` and `dm.properties` return two maps:

```json
{
  "properties": { "Size": { "$t": "Vector3", "x": 4, "y": 1, "z": 2 } },
  "unreadable": { "CollisionGroup": "The current identity cannot read this property" }
}
```

A missing property means the class changed; an unreadable one means Roblox refused. Those need different fixes, so they are never merged.

Roblox exposes no property reflection to Luau, so "read the relevant properties" means a curated per-class set (`plugin/src/Props.luau`). Anything outside it is still reachable by naming it explicitly.

## Scoped inspection

Nothing returns an unbounded result. `dm.tree`, `dm.children`, `dm.search`, and `script.list` all take a limit and report `truncated` when they hit it, so an agent can walk a large place without pulling it into a prompt.

## Script editing

`script.get` reads through `ScriptEditorService` where available, so it reflects unsaved editor changes and matches what the user sees. Writes go back the same way, because assigning `Source` directly can be discarded when the script is open in a tab.

`script.patch` is preferred over `script.set`. A `find` that matches more than once is rejected rather than guessed at — replacing the wrong occurrence in a script is a silent bug the agent will not notice until much later.

## Failures

| Code | Meaning |
|---|---|
| `STUDIO_NOT_CONNECTED` | No paired Studio session |
| `SESSION_UNKNOWN` | The named session is gone |
| `STUDIO_TIMEOUT` | Studio accepted the command but did not finish it |
| `TARGET_NOT_FOUND` | The path or handle resolves to nothing |
| `TARGET_STALE` | The handle's instance was destroyed or detached |
| `TARGET_AMBIGUOUS` | The path matched several instances |
| `WRONG_REALM` | The handle came from a different edit/run realm |
| `NOT_ALLOWED_BY_ROBLOX` | Roblox refused the operation |
| `INVALID_PARAMS` | Parameters failed validation |
| `UNSUPPORTED_CAPABILITY` | Not available in this Studio version, OS, or state |
| `PLAYTEST_NOT_RUNNING` / `PLAYTEST_ALREADY_RUNNING` | Wrong run state |
| `RUNTIME_CONTEXT_UNAVAILABLE` | The requested client or server context does not exist |
| `INPUT_FAILED` | Input could not be delivered |
| `SCREENSHOT_FAILED` | Capture failed |
| `PERMISSION_DENIED` | The user turned this permission group off |
| `EXECUTION_ERROR` | Executed Luau raised |
| `UNAUTHORIZED` | Missing or wrong local credentials |
| `INTERNAL` | Unclassified |

Failures carry `details` and often a `hint` naming what to try instead.

## Capabilities

`session.capabilities` reports what is usable **right now** and why anything is not:

```json
{
  "id": "input.virtual",
  "available": false,
  "provider": "studio-plugin",
  "reason": "Input can only be delivered while the experience is running."
}
```

Availability changes with the run state, the Studio version, the OS, and the connected session, so it is recomputed on demand rather than cached.
