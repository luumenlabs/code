/**
 * The full Roblox operation surface.
 *
 * One registry drives everything downstream: server-side validation, permission
 * and capability gating, MCP tool generation, and the harness activity log. Any
 * new Studio capability is added here first.
 */
import { z } from "zod";
import type { CapabilityId, PermissionGroup } from "./capabilities.js";
import type { ChangeRecord, RevertOutcome } from "./changes.js";
import { targetSchema } from "./targets.js";
import type { InstanceDetail, InstanceRef, TreeNode } from "./targets.js";
import { rbxPropertyMapSchema, rbxValueSchema } from "./value.js";
import type { RbxValue } from "./value.js";
import type { MultiplayerPhase, PlaytestMode, RunState, StudioRealm } from "./session.js";

/** Where the operation is executed. */
export type Executor = "studio" | "server";

export interface CommandSpec {
  params: z.ZodTypeAny;
  executor: Executor;
  permission: PermissionGroup;
  capability: CapabilityId | null;
  /** True when the operation changes Studio state, for the activity log. */
  mutates: boolean;
  summary: string;
  /**
   * Housekeeping the user did not ask for, and which gets no row in the
   * transcript. Reserved for reads the app makes on its own behalf: a panel
   * refreshing itself is not something the agent did to the place, and a
   * conversation littered with the app's own bookkeeping is unreadable.
   */
  silent?: boolean;
}

const limit = (max: number, fallback: number) => z.number().int().positive().max(max).default(fallback);

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

const servicesParams = z.object({});

const getParams = z.object({
  target: targetSchema,
  properties: z
    .array(z.string())
    .optional()
    .describe("Property names to read. Omit for a curated set appropriate to the instance class."),
  childLimit: limit(200, 50).describe("How many children to list inline."),
});

const childrenParams = z.object({
  target: targetSchema,
  offset: z.number().int().min(0).default(0),
  limit: limit(500, 100),
  className: z.string().optional().describe("Only return children that IsA this class."),
});

const treeParams = z.object({
  target: targetSchema.optional().describe('Root of the subtree. Defaults to the DataModel ("game").'),
  maxDepth: z.number().int().min(1).max(20).default(3),
  maxNodes: limit(2000, 300).describe("Hard cap on returned nodes; the tree is truncated rather than trimmed silently."),
  className: z.string().optional(),
});

const searchParams = z
  .object({
    name: z.string().optional().describe("Substring or pattern to match against instance names."),
    className: z.string().optional().describe("Only match instances that IsA this class."),
    tag: z.string().optional().describe("Only match instances carrying this CollectionService tag."),
    scope: targetSchema.optional().describe("Restrict the search to this subtree."),
    matchMode: z.enum(["substring", "exact", "pattern"]).default("substring"),
    limit: limit(200, 50),
  })
  .refine((value) => Boolean(value.name || value.className || value.tag), {
    message: "Provide at least one of name, className, or tag.",
  });

const propertiesParams = z.object({
  target: targetSchema,
  names: z.array(z.string()).optional(),
});

const selectionGetParams = z.object({});
const selectionSetParams = z.object({ targets: z.array(targetSchema).max(200) });

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const setPropertiesParams = z.object({
  target: targetSchema,
  properties: rbxPropertyMapSchema.describe("Property name to value. Values use the Luu Code JSON value format."),
});

const createParams = z.object({
  className: z.string().min(1),
  parent: targetSchema,
  name: z.string().optional(),
  properties: rbxPropertyMapSchema.optional(),
  attributes: z.record(rbxValueSchema).optional(),
  tags: z.array(z.string()).optional(),
});

const deleteParams = z.object({
  targets: z.array(targetSchema).min(1).max(200),
});

const renameParams = z.object({ target: targetSchema, name: z.string().min(1) });

const reparentParams = z.object({ target: targetSchema, parent: targetSchema });

const cloneParams = z.object({
  target: targetSchema,
  parent: targetSchema.optional().describe("Defaults to the original parent."),
  name: z.string().optional(),
});

const attributesParams = z.object({
  target: targetSchema,
  attributes: z.record(rbxValueSchema.nullable()).describe("Set an attribute, or pass null to remove it."),
});

const tagsParams = z.object({
  target: targetSchema,
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

/** The editing operations that may appear inside a batch. */
export const BATCHABLE_OPS = [
  "dm.create",
  "dm.set_properties",
  "dm.delete",
  "dm.rename",
  "dm.reparent",
  "dm.clone",
  "dm.attributes.set",
  "dm.tags.set",
] as const;

export type BatchableOp = (typeof BATCHABLE_OPS)[number];

/**
 * Many edits, one round trip, one undo waypoint.
 *
 * Building a hundred parts one operation at a time is a hundred requests, a
 * hundred rows in the transcript, and a hundred entries in the user's undo
 * stack for what was one instruction. Each step is still journalled
 * individually, because reviewing and reverting work at the level of the change
 * rather than the batch.
 */
const batchParams = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum(BATCHABLE_OPS),
        params: z.record(z.any()).describe("Exactly the parameters that operation takes on its own."),
      }),
    )
    .min(1)
    .max(200),
  stopOnError: z
    .boolean()
    .default(true)
    .describe("Stop at the first failure. Turn this off only when the steps are genuinely independent; the result reports each one either way."),
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const scriptListParams = z.object({
  scope: targetSchema.optional(),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
  limit: limit(500, 200),
});

const scriptGetParams = z.object({
  target: targetSchema,
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const scriptSetParams = z.object({
  target: targetSchema,
  source: z.string(),
});

const scriptPatchParams = z.object({
  target: targetSchema,
  edits: z
    .array(
      z.union([
        z.object({
          find: z.string().min(1).describe("Exact text to replace. Must be unique unless all is true."),
          replace: z.string(),
          all: z.boolean().default(false),
        }),
        z.object({
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1),
          replacement: z.string().describe("Replacement text for the inclusive line range."),
        }),
      ]),
    )
    .min(1)
    .max(50),
});

const scriptCreateParams = z.object({
  className: z.enum(["Script", "LocalScript", "ModuleScript"]),
  parent: targetSchema,
  name: z.string().min(1),
  source: z.string().default(""),
  properties: rbxPropertyMapSchema.optional(),
});

/**
 * Search across every script's source at once.
 *
 * There is no filesystem to grep here — the source of truth is the DataModel,
 * and reading it a script at a time to find one call site costs a round trip
 * and a context window per file. This is the operation that makes an unfamiliar
 * place navigable: one request, one pass over the descendants, only the lines
 * that matched.
 */
const scriptGrepParams = z.object({
  pattern: z.string().min(1).describe("Text to find. Literal by default."),
  regex: z
    .boolean()
    .default(false)
    .describe(
      "Treat pattern as a Luau string pattern rather than literal text. Luau patterns are not PCRE: use %d %a %w %s classes, '.-' for a lazy match, and escape magic characters with %.",
    ),
  caseSensitive: z.boolean().default(false).describe("Ignored when regex is true; Luau patterns are always case sensitive."),
  scope: targetSchema.optional().describe("Restrict the search to this subtree, for example ServerScriptService."),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
  contextLines: z.number().int().min(0).max(10).default(0).describe("Lines of surrounding context to return with each match."),
  maxMatches: limit(1000, 100).describe("Stop after this many matches in total."),
  maxPerScript: limit(200, 20).describe("Stop after this many matches within any one script."),
  pathsOnly: z.boolean().default(false).describe("Return only which scripts matched, not the matching lines."),
});

// ---------------------------------------------------------------------------
// Playtest
// ---------------------------------------------------------------------------

/**
 * Playtesting is driven entirely through `StudioTestService`.
 *
 * Studio exposes `ExecutePlayModeAsync`, `ExecuteRunModeAsync`,
 * `ExecuteMultiplayerTestAsync` and `EndTest` to plugins, which is a complete,
 * structured way to start and stop a session. Nothing here touches the user's
 * keyboard, focuses a window, or synthesises a shortcut: an agent that can take
 * over the desktop to press Play is one that can press anything else too, and a
 * shortcut is invisible to the user until their typing lands somewhere it
 * should not have.
 *
 * The two halves run in different DataModels and that is not an implementation
 * detail. `ExecutePlayModeAsync` yields for the entire life of the playtest, so
 * only the *edit* peer can start one; `EndTest` only exists in the *running*
 * peer. Every operation below is routed to the peer that can actually perform
 * it rather than to whichever connection happened to be selected.
 */
const runStateParams = z.object({});

const runStartParams = z.object({
  mode: z
    .enum(["play", "run"])
    .default("play")
    .describe(
      '"play" starts a playtest with a character and a client to observe, which is what GUI, input, and gameplay need. "run" starts the place as a server with no player, which is better for server-side logic.',
    ),
  waitReady: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const runStopParams = z.object({
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
});

const runRestartParams = z.object({
  mode: z.enum(["play", "run"]).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const runWaitReadyParams = z.object({
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  requireCharacter: z.boolean().default(true),
});

/**
 * One operation rather than five, because these are the transitions of a single
 * state machine and an agent reading a tool list is better served by one entry
 * that explains the lifecycle than by five that each explain a third of it.
 */
const runMultiplayerParams = z
  .object({
    action: z
      .enum(["start", "status", "add_players", "leave_client", "end"])
      .describe("Which transition to make. Call status first if you are unsure what is already running."),
    players: z.number().int().min(1).max(8).optional().describe("How many client players. Required for start and add_players."),
    client: z.number().int().min(1).max(8).default(1).describe("Which client to act on, 1-based. Used by leave_client."),
    testArgs: rbxValueSchema.optional().describe("Handed to StudioTestService:GetTestArgs() on the server and every client."),
    value: rbxValueSchema.optional().describe("Returned to the edit-side call when the test ends. Used by end."),
    timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  })
  .superRefine((value, ctx) => {
    if ((value.action === "start" || value.action === "add_players") && value.players === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["players"], message: `players is required for action "${value.action}".` });
    }
  });

// ---------------------------------------------------------------------------
// Output and runtime
// ---------------------------------------------------------------------------

const outputGetParams = z.object({
  since: z.string().optional().describe("Cursor from a previous output.mark or output.get call."),
  limit: limit(500, 100),
  types: z.array(z.enum(["output", "info", "warning", "error"])).optional(),
  contains: z.string().optional(),
});

const outputMarkParams = z.object({});
const outputClearParams = z.object({});

const execParams = z.object({
  source: z.string().min(1).describe("Luau to execute. The last expression or return value is sent back, along with anything it printed."),
  /**
   * Which DataModel the code runs in.
   *
   * During a playtest there are two or three live connections and they see
   * different worlds — a server-side table is not readable from the client, and
   * PlayerGui does not exist on the server. Leaving this to "whichever
   * connection is selected" made half of all runtime probes answer about the
   * wrong world, and the answer looked plausible either way.
   */
  realm: z
    .enum(["auto", "edit", "server", "client"])
    .default("auto")
    .describe(
      '"auto" uses the client during a Play session and the edit DataModel otherwise. Name a realm explicitly when the answer depends on which side you are asking: server state, or client-only state like PlayerGui and the camera.',
    ),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
});

// ---------------------------------------------------------------------------
// Input and view
// ---------------------------------------------------------------------------

/**
 * Input is delivered by `UserInputService:CreateVirtualInput()`.
 *
 * That object feeds the engine's real input pipeline: a key reaches
 * `UserInputService.InputBegan` and the default control modules, so W walks the
 * character at its actual WalkSpeed with the controls intact, and a mouse
 * button hit-tests against the GUI exactly as a user's click would. It is also
 * confined to the experience — the user's own mouse and keyboard are never
 * touched, and Studio does not need to be the frontmost window.
 *
 * `VirtualInputManager` is the obvious-looking alternative and it is a trap:
 * every one of its Send* methods is RobloxScriptSecurity, so from a plugin they
 * cannot work. We used it, reported the capability as available, and delivered
 * nothing.
 */
const inputKeyParams = z.object({
  key: z.string().min(1).describe('Enum.KeyCode name, for example "W", "Space", "E", "LeftShift".'),
  action: z
    .enum(["tap", "press", "release"])
    .default("tap")
    .describe('"press" and "release" pair up across calls, so a key can be held down while you do something else.'),
  durationMs: z.number().int().min(0).max(30000).default(60).describe("Hold time for tap."),
});

const inputTextParams = z.object({
  text: z.string().min(1).max(2000).describe("Goes to the focused TextBox, as if typed."),
});

const inputMouseParams = z
  .object({
    action: z.enum(["move", "click", "down", "up", "scroll", "drag"]),
    x: z.number().optional().describe("Viewport pixel X, or 0-1 when normalized is true. Defaults to the middle of the viewport."),
    y: z.number().optional(),
    toX: z.number().optional().describe("Drag destination."),
    toY: z.number().optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scrollDelta: z.number().default(1).describe("Wheel clicks; negative scrolls the other way."),
    normalized: z.boolean().default(false),
    durationMs: z.number().int().min(0).max(10000).default(80).describe("How long a drag takes. The path is interpolated, so drag handlers see movement rather than a teleport."),
  })
  .refine((value) => value.action !== "drag" || (value.toX !== undefined && value.toY !== undefined), {
    message: "A drag needs toX and toY.",
    path: ["toX"],
  });

const inputGuiClickParams = z
  .object({
    target: targetSchema.optional().describe("The GuiObject to click."),
    text: z.string().optional().describe('Find a visible GuiButton or TextLabel whose text matches, for example "Buy".'),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scope: targetSchema.optional().describe("Restrict the text search to this subtree, for example a specific ScreenGui."),
  })
  .refine((value) => Boolean(value.target || value.text), {
    message: "Provide either target or text.",
  });

const viewportInfoParams = z.object({});

/**
 * Two capture paths, and the default is the one inside the engine.
 *
 * `CaptureService:CaptureScreenshot` gives the rendered viewport and nothing
 * else — no ribbon, no Explorer, no other application that happens to be on top
 * — and it works while a playtest is running, which is when a screenshot is
 * worth taking. It needs the window to be drawing frames, and reading the
 * pixels back needs the place's Mesh/Image API permission, so both failures are
 * reported by name with `window` offered as the way round them.
 *
 * The desktop paths are kept because those two conditions are real. They
 * capture pixels that are already on screen and can never see an occluded or
 * minimised window.
 */
/**
 * The on-screen interface as structure. Rectangles are in the same viewport
 * pixels `input.mouse` takes, and clickability is Roblox's own hit test through
 * `GetGuiObjectsAtPosition` rather than a guess from rectangles and ZIndex.
 */
const guiParams = z.object({
  scope: targetSchema
    .optional()
    .describe("Root to read from. Defaults to the player's own GUI during a playtest, and StarterGui in edit mode."),
  visibleOnly: z
    .boolean()
    .default(true)
    .describe("Skip anything the user cannot see. Turn off to find out why something is not showing."),
  interactiveOnly: z.boolean().default(false).describe("Only elements that can actually be clicked."),
  maxDepth: z.number().int().min(1).max(20).default(12),
  maxNodes: limit(2000, 400),
});

/** The camera is the user's, so the position taken over is remembered for restore. */
const focusParams = z.object({
  target: targetSchema.optional().describe("What to frame. Uses the current Studio selection when omitted."),
  angle: z
    .enum(["front", "back", "left", "right", "top", "iso"])
    .default("iso")
    .describe('Which side to look from. "iso" is the three-quarter view that shows depth.'),
  padding: z.number().min(1).max(5).default(1.4).describe("How much room to leave around the subject. 1 is tight to the bounding box."),
  restore: z
    .boolean()
    .default(false)
    .describe("Put the camera back where the user had it instead of moving it. Ignores target and angle."),
});

/**
 * Marks instances in the viewport, so a screenshot explains itself.
 *
 * The adornments live in CoreGui with the target as their Adornee, so nothing
 * is added to the place, nothing is saved with it, and nothing has to be
 * journalled or reverted. They are the agent pointing at something, not editing
 * it.
 */
const highlightParams = z.object({
  targets: z.array(targetSchema).max(50).default([]).describe("What to mark. An empty list clears every mark."),
  color: z.string().optional().describe('Hex colour such as "#2b7fff". Defaults to the Luu Code blue.'),
  label: z.string().max(120).optional().describe("Shown beside the first target."),
  clearAfterMs: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .default(0)
    .describe("Remove the marks automatically after this long. 0 leaves them until cleared."),
});

const screenshotParams = z.object({
  source: z
    .enum(["viewport", "window", "screen"])
    .default("viewport")
    .describe(
      '"viewport" captures what the experience is rendering, from inside Studio. "window" captures the whole Roblox Studio window from the desktop. "screen" captures the primary display.',
    ),
  maxWidth: z.number().int().min(160).max(4096).default(1280).describe("The image is scaled down to this width before it is sent."),
});

// ---------------------------------------------------------------------------
// Performance and tests
// ---------------------------------------------------------------------------

/**
 * What the engine is actually doing, over a window of time.
 *
 * "Is this laggy, and why" is a question agents are asked constantly and have
 * so far had no way to answer — output says nothing about frame time, and a
 * screenshot cannot show a stutter. One instant reading is noise, so this
 * averages over a span and reports the worst frame alongside the mean, because
 * a game that hitches once a second has a good average.
 */
const perfSampleParams = z.object({
  durationMs: z.number().int().min(200).max(30000).default(3000).describe("How long to watch for."),
  includeMemory: z
    .boolean()
    .default(true)
    .describe("Break memory down by category. Slightly slower, and the only way to see which system is holding it."),
});

const perfCountParams = z.object({
  scope: targetSchema.optional().describe('Subtree to count. Defaults to the whole DataModel.'),
  /**
   * A census is only useful next to the thing it indicts, so the heaviest
   * subtrees come back with it rather than a total the agent then has to go
   * hunting through the tree to explain.
   */
  topClasses: limit(50, 12).describe("How many classes to list, largest first."),
  topSubtrees: limit(50, 8).describe("How many of the heaviest containers to name."),
});

/**
 * Runs the place's own TestService suite.
 *
 * Results are collected from the service's signals rather than scraped out of
 * the output buffer, so a failure comes back as a failure with its script and
 * line rather than as a line of text that happens to contain the word.
 */
const testRunParams = z.object({
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
});

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

const changesListParams = z.object({
  chat: z.string().min(1).optional().describe("Only changes made for this conversation. Omit for every change in the window."),
  limit: limit(2000, 500),
  includeReverted: z.boolean().default(true),
});

const changesRevertParams = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500).describe("Change ids from changes.list, in any order."),
  force: z
    .boolean()
    .default(false)
    .describe("Put the change back even where the instance has been edited since. Off by default: a conflict is reported instead."),
});

/**
 * The Studio half of a revert.
 *
 * Records travel with the request rather than being held in the plugin, so the
 * server stays the single owner of the journal and the plugin only holds what
 * cannot be described in JSON — the copy of a destroyed subtree.
 */
const changesApplyParams = z.object({
  records: z.array(z.any()).min(1).max(500),
  force: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const statusParams = z.object({});
const capabilitiesParams = z.object({});
const sessionSelectParams = z.object({
  sessionId: z.string().min(1),
  /**
   * Binds one conversation to that session instead of moving the default for
   * everyone. Omitted, it moves the default, which is what an external client
   * with no chat of its own means.
   */
  chat: z.string().min(1).optional(),
});

export const COMMANDS = {
  "session.status": {
    params: statusParams,
    executor: "server",
    permission: "inspect",
    capability: null,
    mutates: false,
    summary: "Report Studio connection state, the active session, and the current run state.",
  },
  "session.capabilities": {
    params: capabilitiesParams,
    executor: "server",
    permission: "inspect",
    capability: null,
    mutates: false,
    summary: "List which Roblox capabilities are usable right now and why any are unavailable.",
  },
  "session.select": {
    params: sessionSelectParams,
    executor: "server",
    permission: "inspect",
    capability: null,
    mutates: false,
    summary: "Choose which connected Studio session this conversation works in.",
  },

  "dm.services": {
    params: servicesParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "List the top-level services in the DataModel with their child counts.",
  },
  "dm.get": {
    params: getParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Inspect one instance: class, path, properties, attributes, tags, and children.",
  },
  "dm.children": {
    params: childrenParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "List the children of an instance, with paging.",
  },
  "dm.tree": {
    params: treeParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Read a bounded subtree of the DataModel.",
  },
  "dm.search": {
    params: searchParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Find instances by name, class, or tag within an optional scope.",
  },
  "dm.properties": {
    params: propertiesParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Read specific properties from an instance.",
  },
  "dm.selection.get": {
    params: selectionGetParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.selection",
    mutates: false,
    summary: "Read what the user currently has selected in Studio.",
  },
  "dm.selection.set": {
    params: selectionSetParams,
    executor: "studio",
    permission: "edit",
    capability: "inspect.selection",
    mutates: true,
    summary: "Set the Studio selection so the user can see what the agent is working on.",
  },

  "dm.set_properties": {
    params: setPropertiesParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Change properties on an instance.",
  },
  "dm.create": {
    params: createParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Create an instance under a parent, optionally with properties, attributes, and tags.",
  },
  "dm.delete": {
    params: deleteParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Destroy one or more instances.",
  },
  "dm.rename": {
    params: renameParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Rename an instance.",
  },
  "dm.reparent": {
    params: reparentParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Move an instance to a new parent.",
  },
  "dm.clone": {
    params: cloneParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Clone an instance.",
  },
  "dm.attributes.set": {
    params: attributesParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Set or remove attributes on an instance.",
  },
  "dm.tags.set": {
    params: tagsParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Add or remove CollectionService tags on an instance.",
  },
  "dm.batch": {
    params: batchParams,
    executor: "server",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Apply a sequence of edits in one round trip, under a single undo waypoint.",
  },

  "script.list": {
    params: scriptListParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.scripts",
    mutates: false,
    summary: "List scripts in the place, optionally scoped to a subtree.",
  },
  "script.get": {
    params: scriptGetParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.scripts",
    mutates: false,
    summary: "Read script source from Studio, optionally a line range.",
  },
  "script.set": {
    params: scriptSetParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.scripts",
    mutates: true,
    summary: "Replace a script's entire source.",
  },
  "script.patch": {
    params: scriptPatchParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.scripts",
    mutates: true,
    summary: "Apply targeted find/replace or line-range edits to a script without rewriting the whole file.",
  },
  "script.create": {
    params: scriptCreateParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.scripts",
    mutates: true,
    summary: "Create a new script with source.",
  },
  "script.grep": {
    params: scriptGrepParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.scripts",
    mutates: false,
    summary: "Search every script's source for a pattern and return the matching lines.",
  },

  "run.state": {
    params: runStateParams,
    executor: "studio",
    permission: "inspect",
    capability: null,
    mutates: false,
    summary: "Report whether the place is in edit mode or running, and which realm is observable.",
  },
  // Playtest transitions are orchestrated by the server, not by Studio, for two
  // reasons. The DataModel that receives the request is torn down by it, so the
  // connection that would report the outcome is often gone before it can. And
  // the peer that can start a playtest is never the peer that can stop one:
  // starting belongs to the edit DataModel and stopping to the running one, so
  // something outside both has to decide where each request goes.
  "run.start": {
    params: runStartParams,
    executor: "server",
    permission: "playtest",
    capability: "playtest.play",
    mutates: true,
    summary: "Start a playtest and optionally wait until it is ready to observe.",
  },
  "run.stop": {
    params: runStopParams,
    executor: "server",
    permission: "playtest",
    capability: "playtest.run",
    mutates: true,
    summary: "Stop the running playtest and return Studio to edit mode.",
  },
  "run.restart": {
    params: runRestartParams,
    executor: "server",
    permission: "playtest",
    capability: "playtest.run",
    mutates: true,
    summary: "Stop and restart the playtest, for example after changing a server script.",
  },
  "run.wait_ready": {
    params: runWaitReadyParams,
    executor: "studio",
    permission: "playtest",
    capability: "playtest.run",
    mutates: false,
    summary: "Wait until the running experience is ready enough to observe.",
  },
  "run.multiplayer": {
    params: runMultiplayerParams,
    executor: "server",
    permission: "playtest",
    capability: "playtest.multiplayer",
    mutates: true,
    summary: "Start, inspect, grow, or end a multi-client Studio test session.",
  },

  "output.get": {
    params: outputGetParams,
    executor: "server",
    permission: "inspect",
    capability: "output.capture",
    mutates: false,
    summary: "Read recent Studio output, filtered by type and bounded by a cursor.",
  },
  "output.mark": {
    params: outputMarkParams,
    executor: "server",
    permission: "inspect",
    capability: "output.capture",
    mutates: false,
    summary: "Return a cursor so a later output.get shows only what happened after this point.",
  },
  "output.clear": {
    params: outputClearParams,
    executor: "server",
    permission: "inspect",
    capability: "output.capture",
    mutates: false,
    summary: "Drop buffered output.",
  },

  "runtime.exec": {
    params: execParams,
    executor: "studio",
    permission: "exec",
    capability: "runtime.exec",
    mutates: true,
    summary: "Execute Luau inside the connected Studio session and return the result.",
  },

  "input.key": {
    params: inputKeyParams,
    executor: "studio",
    permission: "input",
    capability: "input.virtual",
    mutates: true,
    summary: "Send a keyboard event to the running experience.",
  },
  "input.text": {
    params: inputTextParams,
    executor: "studio",
    permission: "input",
    capability: "input.virtual",
    mutates: true,
    summary: "Type text into the running experience.",
  },
  "input.mouse": {
    params: inputMouseParams,
    executor: "studio",
    permission: "input",
    capability: "input.virtual",
    mutates: true,
    summary: "Move, click, drag, or scroll the mouse in the running experience.",
  },
  "input.gui_click": {
    params: inputGuiClickParams,
    executor: "studio",
    permission: "input",
    capability: "input.virtual",
    mutates: true,
    summary: "Click a GUI element by instance or visible text, resolving its on-screen position first.",
  },
  "view.viewport_info": {
    params: viewportInfoParams,
    executor: "studio",
    permission: "inspect",
    capability: "runtime.inspect",
    mutates: false,
    summary: "Read viewport size, GUI inset, and camera state, for mapping coordinates.",
  },
  "view.gui": {
    params: guiParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Read the on-screen interface as structure: every element's rectangle, text, and whether a click would reach it.",
  },
  "view.screenshot": {
    params: screenshotParams,
    executor: "server",
    permission: "screenshot",
    capability: "view.screenshot",
    mutates: false,
    summary: "Capture the Roblox Studio window as an image.",
  },
  // The camera and the adornments are the user's viewport, not their place:
  // nothing here is journalled, because there is nothing to put back.
  "view.focus": {
    params: focusParams,
    executor: "studio",
    permission: "screenshot",
    capability: "view.camera",
    mutates: false,
    summary: "Point the Studio camera at an instance so a screenshot shows it.",
  },
  "view.highlight": {
    params: highlightParams,
    executor: "studio",
    permission: "screenshot",
    capability: "view.camera",
    mutates: false,
    summary: "Mark instances in the viewport, or clear the marks.",
  },

  "perf.sample": {
    params: perfSampleParams,
    executor: "studio",
    permission: "inspect",
    capability: "perf.stats",
    mutates: false,
    summary: "Watch frame time, draw calls, and memory over a span and report the mean and the worst frame.",
  },
  "perf.count": {
    params: perfCountParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Count what is in the place by class, and name the heaviest containers.",
  },

  "test.run": {
    params: testRunParams,
    executor: "studio",
    permission: "playtest",
    capability: "test.run",
    mutates: true,
    summary: "Run the place's TestService suite and report each result.",
  },

  "changes.list": {
    params: changesListParams,
    executor: "server",
    permission: "inspect",
    capability: null,
    mutates: false,
    // Read from the server's own journal, so it answers with Studio closed —
    // which is exactly when someone wants to read what was done to the place.
    silent: true,
    summary: "List the DataModel changes recorded in this session, with what each one changed.",
  },
  "changes.revert": {
    params: changesRevertParams,
    executor: "server",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Put recorded changes back, newest first, refusing any the user has edited since.",
  },
  "changes.apply": {
    params: changesApplyParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.instances",
    mutates: true,
    summary: "Internal: apply the inverse of a set of change records inside Studio.",
  },
} as const satisfies Record<string, CommandSpec>;

export type Op = keyof typeof COMMANDS;

/**
 * What each operation is called when an agent reaches it.
 *
 * Names are deliberately hand-written rather than derived from op ids: an agent
 * reads them as a menu, and "studio_edit_script" says more than "script_patch".
 *
 * They live here, beside the operations, and the exhaustive `satisfies` is the
 * point of the file — the MCP list, the permission controls, and the settings
 * the user has saved all key on these, and a name that existed in one of those
 * places and not another is a tool that silently cannot be turned off. `null`
 * means the operation is machinery rather than something an agent calls.
 */
export const TOOL_NAMES = {
  "session.status": "studio_status",
  "session.capabilities": "studio_capabilities",
  "session.select": "studio_select_session",

  "dm.services": "studio_services",
  "dm.get": "studio_inspect",
  "dm.children": "studio_children",
  "dm.tree": "studio_tree",
  "dm.search": "studio_search",
  "dm.properties": "studio_get_properties",
  "dm.selection.get": "studio_get_selection",
  "dm.selection.set": "studio_set_selection",
  "dm.set_properties": "studio_set_properties",
  "dm.create": "studio_create_instance",
  "dm.delete": "studio_delete_instance",
  "dm.rename": "studio_rename_instance",
  "dm.reparent": "studio_move_instance",
  "dm.clone": "studio_clone_instance",
  "dm.attributes.set": "studio_set_attributes",
  "dm.tags.set": "studio_set_tags",
  "dm.batch": "studio_batch_edit",

  "script.list": "studio_list_scripts",
  "script.get": "studio_read_script",
  "script.grep": "studio_grep_scripts",
  "script.set": "studio_write_script",
  "script.patch": "studio_edit_script",
  "script.create": "studio_create_script",

  "run.state": "studio_run_state",
  "run.start": "studio_start_playtest",
  "run.stop": "studio_stop_playtest",
  "run.restart": "studio_restart_playtest",
  "run.wait_ready": "studio_wait_ready",
  "run.multiplayer": "studio_multiplayer_test",

  "output.get": "studio_output",
  "output.mark": "studio_mark_output",
  "output.clear": "studio_clear_output",

  "runtime.exec": "studio_exec",

  "input.key": "studio_press_key",
  "input.text": "studio_type_text",
  "input.mouse": "studio_mouse",
  "input.gui_click": "studio_click_gui",

  "view.viewport_info": "studio_viewport",
  "view.gui": "studio_screen",
  "view.screenshot": "studio_screenshot",
  "view.focus": "studio_focus",
  "view.highlight": "studio_highlight",

  "perf.sample": "studio_measure",
  "perf.count": "studio_census",

  "test.run": "studio_run_tests",

  // Read and written by the app's own review panel. An agent has the change
  // journal stripped out of its results by design, so none of this is a tool it
  // could use.
  "changes.list": null,
  "changes.revert": null,
  "changes.apply": null,
} as const satisfies Record<Op, string | null>;

/** Every operation an agent can reach, in the order they are declared. */
export const AGENT_OPS = (Object.keys(COMMANDS) as Op[]).filter((op) => TOOL_NAMES[op] !== null);

export function toolNameFor(op: Op): string | null {
  return TOOL_NAMES[op];
}

export type CommandParams<O extends Op> = z.infer<(typeof COMMANDS)[O]["params"]>;

/** Params as callers provide them, before zod applies defaults. */
export type CommandInput<O extends Op> = z.input<(typeof COMMANDS)[O]["params"]>;

export const OPS = Object.keys(COMMANDS) as Op[];

export function isOp(value: unknown): value is Op {
  return typeof value === "string" && value in COMMANDS;
}

/**
 * True when the operation is the app's own bookkeeping and earns no row in the
 * transcript. Read through a function because `COMMANDS` is inferred literally,
 * so the field is simply absent on every entry that does not set it.
 */
export function isSilent(op: Op): boolean {
  return (COMMANDS[op] as CommandSpec).silent === true;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface OutputEntry {
  /** Monotonic cursor value; also usable as `since`. */
  cursor: string;
  timestamp: number;
  type: "output" | "info" | "warning" | "error";
  message: string;
  /** Script path and line when Studio reports one. */
  source: string | null;
  /** Stack trace for errors, when available. */
  stack: string | null;
  realm: StudioRealm;
}

export interface ExecResult {
  /** Serialized return value, or null when the code returned nothing. */
  value: RbxValue;
  /** Anything the executed code printed. */
  output: string[];
  realm: StudioRealm;
  elapsedMs: number;
}

export interface ViewportInfo {
  viewportSize: { x: number; y: number };
  guiInset: { x: number; y: number };
  camera: {
    position: [number, number, number];
    lookVector: [number, number, number];
    fieldOfView: number;
    cameraType: string;
  } | null;
  realm: StudioRealm;
  /**
   * False when the Studio window is minimised or otherwise not drawing. Input
   * and screenshots both need frames, so this is the first thing to check when
   * either appears to do nothing.
   */
  rendering: boolean;
}

export interface ScreenshotResult {
  /** Base64 PNG. */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  capturedAt: number;
  /** Which path produced it, since the three see different things. */
  source: "viewport" | "window" | "screen";
  /** The DataModel the viewport was captured from. Null for a desktop capture. */
  realm: StudioRealm | null;
}

export interface GrepMatch {
  /** 1-based line number in the script's source. */
  line: number;
  /** 1-based column where the match starts. */
  column: number;
  text: string;
  /** Lines immediately before and after, when contextLines asked for them. */
  before: string[];
  after: string[];
}

export interface GrepFile {
  instance: InstanceRef;
  matches: GrepMatch[];
  /** Matches in this script, which exceeds `matches.length` when maxPerScript cut it short. */
  matchCount: number;
}

/**
 * One step of a batch, in the order it was requested.
 *
 * A step that never ran because an earlier one failed is reported as `skipped`
 * rather than omitted: the agent asked for a sequence, and knowing where the
 * sequence stopped is the whole point.
 */
export interface BatchStep {
  index: number;
  op: BatchableOp;
  status: "ok" | "failed" | "skipped";
  instances: InstanceRef[];
  error: import("./errors.js").WireError | null;
}

export interface PlayerRef {
  name: string;
  userId: number;
  displayName: string;
}

/**
 * One element of the on-screen interface.
 *
 * The rectangle is in the same viewport pixels `input.mouse` takes and
 * `view.screenshot` returns, so a position read here can be clicked without
 * conversion. That is the whole point of the operation.
 */
export interface ScreenNode {
  handle: string;
  path: string;
  name: string;
  className: string;
  depth: number;
  /** Viewport pixels: x and y are the top-left corner. */
  rect: { x: number; y: number; width: number; height: number };
  /** Text the element displays, when it has any. */
  text: string | null;
  /** Effective draw order among siblings. Higher is nearer the front. */
  zIndex: number;
  visible: boolean;
  /**
   * True when a click at the element's centre reaches it, asked of Roblox
   * rather than worked out from rectangles. False here with `visible` true is
   * the signature of something covered by an invisible frame — the failure that
   * is otherwise almost impossible to diagnose from a screenshot.
   */
  clickable: boolean;
  /** What the engine reports on top at this element's centre, when it is not this one. */
  obscuredBy: string | null;
}

export interface CameraState {
  position: [number, number, number];
  lookVector: [number, number, number];
  fieldOfView: number;
}

export interface PerfReading {
  /** Mean over the sample. */
  mean: number;
  /** The single worst frame, which is what a stutter actually is. */
  worst: number;
}

export interface PerfSample {
  durationMs: number;
  frames: number;
  realm: StudioRealm;
  running: boolean;
  /** Milliseconds per frame, and what the mean works out to in frames per second. */
  frameTime: PerfReading;
  fps: number;
  renderCpuMs: PerfReading;
  renderGpuMs: PerfReading;
  physicsStepMs: PerfReading;
  drawCalls: PerfReading;
  triangles: PerfReading;
  instanceCount: number;
  movingParts: number;
  /** Total megabytes, and the categories holding the most. */
  memoryMb: number;
  memoryByCategory: Array<{ category: string; megabytes: number }>;
  /** Anything Studio would not report, named rather than silently zero. */
  unavailable: string[];
}

export interface TestOutcome {
  status: "passed" | "failed" | "warned" | "message";
  message: string;
  /** The script that reported it, when TestService named one. */
  source: string | null;
  line: number | null;
}

export interface MultiplayerState {
  phase: MultiplayerPhase;
  /** Identifies this test run, so a status call can tell it from the last one. */
  testId: string | null;
  /** Clients the session was asked for. */
  players: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** What EndTest handed back to the edit-side call, once the test has finished. */
  value: RbxValue | null;
  error: string | null;
  /** Players actually connected, as seen by the running server peer. */
  connected: PlayerRef[];
}

export interface MutationResult {
  /** What the operation actually touched, so the agent can confirm the target. */
  instances: InstanceRef[];
  /** Undo waypoint name recorded in Studio, when undo history was available. */
  undoLabel: string | null;
  /**
   * Before and after, for the change journal.
   *
   * The server takes these out of the result before it reaches the agent. They
   * are for the user's review panel, not for the model: the old source of a
   * script it just rewrote is the single largest thing this protocol can carry,
   * and handing it back to the agent that supplied the new one would double the
   * cost of every write to say nothing it does not already know.
   */
  changes?: import("./changes.js").ChangeDraft[];
}

export interface ScriptSourceResult {
  instance: InstanceRef;
  source: string;
  /** 1-based line range actually returned. */
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface SearchResult {
  matches: InstanceRef[];
  truncated: boolean;
}

export interface GuiClickResult {
  clicked: InstanceRef;
  /** Viewport coordinates the click was delivered to. */
  position: { x: number; y: number };
  /** Candidates when a text search matched more than one element. */
  otherMatches: InstanceRef[];
}

export interface CommandResults {
  "session.status": import("./session.js").SessionStatus;
  "session.capabilities": import("./capabilities.js").CapabilityReport;
  "session.select": import("./session.js").SessionStatus;

  "dm.services": { services: InstanceRef[] };
  "dm.get": InstanceDetail & {
    children: InstanceRef[];
    childrenTruncated: boolean;
    /** Property name to the reason Roblox refused to read it. */
    unreadable: Record<string, string>;
  };
  "dm.children": { children: InstanceRef[]; total: number; offset: number };
  "dm.tree": { root: TreeNode; nodeCount: number; truncated: boolean };
  "dm.search": SearchResult;
  "dm.properties": { instance: InstanceRef; properties: Record<string, RbxValue>; unreadable: Record<string, string> };
  "dm.selection.get": { selection: InstanceRef[] };
  "dm.selection.set": { selection: InstanceRef[] };

  "dm.set_properties": MutationResult & { applied: string[]; rejected: Record<string, string> };
  "dm.create": MutationResult;
  "dm.delete": MutationResult & { deleted: number };
  "dm.rename": MutationResult;
  "dm.reparent": MutationResult;
  "dm.clone": MutationResult;
  "dm.attributes.set": MutationResult & { applied: string[] };
  "dm.tags.set": MutationResult & { tags: string[] };
  "dm.batch": MutationResult & { steps: BatchStep[]; applied: number; failed: number; skipped: number };

  "script.list": { scripts: InstanceRef[]; truncated: boolean };
  "script.get": ScriptSourceResult;
  "script.set": MutationResult & { lineCount: number };
  "script.patch": MutationResult & { applied: number; lineCount: number; diff: string };
  "script.create": MutationResult & { lineCount: number };
  "script.grep": {
    files: GrepFile[];
    /** Total matches found, which exceeds the sum of what is returned when a limit cut it short. */
    matchCount: number;
    scriptsSearched: number;
    /**
     * Scripts whose source Studio refused to hand over, and which were skipped.
     * One locked module should not hide every other match, but an empty result
     * with a count here means something different from an empty result without.
     */
    unreadable: number;
    truncated: boolean;
  };

  // `multiplayerPhase` is "idle" rather than absent when there is no session, so
  // it never has to be told apart from a plugin too old to report one.
  "run.state": RunState & { mode: PlaytestMode | null; multiplayerPhase: MultiplayerPhase };
  "run.start": RunState & { ready: boolean };
  "run.stop": RunState;
  "run.restart": RunState & { ready: boolean };
  "run.wait_ready": RunState & { ready: boolean };
  "run.multiplayer": MultiplayerState & { run: RunState };

  "output.get": { entries: OutputEntry[]; cursor: string; truncated: boolean };
  "output.mark": { cursor: string };
  "output.clear": { cleared: number };

  "runtime.exec": ExecResult;

  // `delivered: true` and nothing else would be a claim these operations are
  // not in a position to make. The realm says which world the input went into,
  // which is the part an agent can check against what it expected.
  "input.key": { delivered: true; key: string; action: string; realm: StudioRealm };
  "input.text": { delivered: true; length: number; realm: StudioRealm };
  "input.mouse": { delivered: true; position: { x: number; y: number }; realm: StudioRealm };
  "input.gui_click": GuiClickResult;
  "view.viewport_info": ViewportInfo;
  "view.gui": {
    nodes: ScreenNode[];
    /** Where the tree was read from, since the default differs between edit and a playtest. */
    root: InstanceRef | null;
    viewportSize: { x: number; y: number };
    guiInset: { x: number; y: number };
    realm: StudioRealm;
    /**
     * False when this DataModel offers no hit testing, which is every context
     * without a LocalPlayer — edit mode included. `clickable` is then false on
     * every node because it is unknown, not because nothing can be clicked, and
     * an agent needs to be able to tell those apart.
     */
    hitTested: boolean;
    truncated: boolean;
  };
  "view.screenshot": ScreenshotResult;
  "view.focus": {
    camera: CameraState;
    /** What was framed, or null when the camera was put back. */
    framed: InstanceRef | null;
    /** True while a previous position is remembered and can be restored. */
    canRestore: boolean;
  };
  "view.highlight": { marked: InstanceRef[]; cleared: number };

  "perf.sample": PerfSample;
  "perf.count": {
    total: number;
    scope: InstanceRef | null;
    byClass: Array<{ className: string; count: number }>;
    heaviest: Array<{ instance: InstanceRef; descendants: number }>;
    parts: number;
    scripts: number;
    truncated: boolean;
  };

  "test.run": {
    outcomes: TestOutcome[];
    passed: number;
    failed: number;
    warned: number;
    /** True when the suite was still running when the deadline passed. */
    timedOut: boolean;
    elapsedMs: number;
  };

  "changes.list": { records: ChangeRecord[]; total: number; truncated: boolean };
  "changes.revert": { outcomes: RevertOutcome[]; reverted: number };
  "changes.apply": { outcomes: RevertOutcome[] };
}

export type CommandResult<O extends Op> = CommandResults[O];
