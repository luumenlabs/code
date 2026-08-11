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

/**
 * Roblox exposes no property reflection to Luau, so the class is described by
 * asking a real instance of it: which members exist, what type each value is,
 * and whether a write takes. Names the caller supplies are probed alongside the
 * curated set, which is how a guessed property name is checked in one call
 * rather than one rejected write at a time.
 */
const classInfoParams = z
  .object({
    className: z.string().min(1).optional().describe('The class to describe, for example "ProximityPrompt". Case sensitive.'),
    target: targetSchema.optional().describe("Describe the class of this instance instead, when you have a handle rather than a name."),
    members: z
      .array(z.string().min(1))
      .max(100)
      .default([])
      .describe(
        "Member names to check on top of the curated set. Anything the class does not have comes back under unknown with the nearest name it does have, so a misspelling is named rather than guessed at.",
      ),
  })
  .refine((value) => Boolean(value.className || value.target), { message: "Provide either className or target." });

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
 * Many edits, one round trip, one undo waypoint. Each step is still journalled
 * individually, because revert works at the level of the change.
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

/** One pass over every script's source. There is no filesystem here to grep. */
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

/**
 * The write half of grep. Renaming one function across forty scripts is
 * otherwise forty round trips and forty entries in the user's history; this is
 * one of each, and still one journal record per script so a bad pattern can be
 * taken back in a single action.
 */
const scriptReplaceParams = z.object({
  pattern: z.string().min(1).describe("Text to find. Literal by default."),
  replacement: z
    .string()
    .describe("What to put in its place. With regex on, %1 and %2 refer to captures; a literal % must be written %%."),
  regex: z
    .boolean()
    .default(false)
    .describe(
      "Treat pattern as a Luau string pattern rather than literal text. Luau patterns are not PCRE: use %d %a %w %s classes, '.-' for a lazy match, and escape magic characters with %.",
    ),
  caseSensitive: z.boolean().default(false).describe("Ignored when regex is true; Luau patterns are always case sensitive."),
  scope: targetSchema.optional().describe("Restrict the replacement to this subtree, for example ServerScriptService."),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Report what would change without writing anything. Worth one call before a wide pattern."),
  maxReplacements: limit(5000, 500).describe("Ceiling on total replacements. The operation fails rather than writing a partial sweep if the pattern matches more than this."),
  maxPerScript: limit(500, 50).describe("Ceiling on replacements within any one script, applied the same way."),
  contextLimit: limit(100, 10).describe("How many changed lines to show per script, in both versions."),
});

// ---------------------------------------------------------------------------
// Playtest
// ---------------------------------------------------------------------------

/**
 * Playtesting is `StudioTestService` throughout — nothing here touches the
 * user's keyboard or window. The halves run in different DataModels: only the
 * edit peer can start a session, only a running one can end it, so each
 * operation is routed to the peer that can perform it.
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

/** One operation rather than five: these are the transitions of one state machine. */
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

/**
 * Simulated network conditions, through `settings():GetService("NetworkSettings")`.
 *
 * Replication bugs do not reproduce on a link with no latency, which is the
 * only link a Studio playtest has. Every field is read back after the write, so
 * a build that does not expose one is reported rather than assumed applied.
 */
const runNetworkParams = z
  .object({
    profile: z
      .enum(["great", "good", "poor", "custom", "reset"])
      .describe(
        'Preset conditions: "great" is 30ms round trip, "good" is 100ms with 10ms of jitter, "poor" is 300ms with 100ms of jitter and packet loss. "reset" puts the link back to no simulation, which is where every playtest starts.',
      ),
    latencyMs: z
      .number()
      .min(0)
      .max(2000)
      .optional()
      .describe("Round trip in milliseconds, split evenly between the two directions. Used by custom."),
    jitterMs: z.number().min(0).max(1000).optional().describe("Variation applied in each direction. Used by custom."),
    lossPercent: z
      .number()
      .min(0)
      .max(0.5)
      .optional()
      .describe("Packets dropped in each direction. Roblox caps this at 0.5%, and a higher value is refused rather than clamped."),
    realm: z
      .enum(["client", "server", "edit"])
      .default("client")
      .describe("Which DataModel applies the change. The simulated link belongs to the client, so that is the default."),
  })
  .superRefine((value, ctx) => {
    if (value.profile !== "custom") return;
    if (value.latencyMs === undefined && value.jitterMs === undefined && value.lossPercent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latencyMs"],
        message: 'A custom profile needs at least one of latencyMs, jitterMs, or lossPercent. Use "reset" to clear the simulation.',
      });
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
   * Which DataModel the code runs in. During a playtest the peers see different
   * worlds, and a probe run in the wrong one answers plausibly and wrongly.
   */
  realm: z
    .enum(["auto", "edit", "server", "client"])
    .default("auto")
    .describe(
      '"auto" uses the client during a Play session and the edit DataModel otherwise. Name a realm explicitly when the answer depends on which side you are asking: server state, or client-only state like PlayerGui and the camera.',
    ),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
});

/**
 * Log breakpoints, through `ScriptDebuggerService`.
 *
 * These log and carry on; nothing here pauses a playtest. A breakpoint that
 * stops execution needs a debugger sitting on the other end to resume it, and
 * without one the playtest hangs with both peers unreachable — so the stopping
 * kind is not offered rather than offered and warned about.
 *
 * The point is to watch a line without editing the script it is on: no print to
 * add, none to forget to remove, and no journal record for a debugging aid.
 */
const breakpointsParams = z
  .object({
    action: z
      .enum(["set", "remove", "clear", "list"])
      .describe('"clear" removes every breakpoint Luu Code set in that realm, and leaves the user\'s own alone.'),
    target: targetSchema.optional().describe("The script to watch. Required for set and remove."),
    line: z.number().int().min(1).optional().describe("1-based line. Required for set and remove."),
    log: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'What to log, as a Luau expression list evaluated at that line: \'"health", humanoid.Health\'. Literal text has to be quoted. Required for set.',
      ),
    condition: z
      .string()
      .max(500)
      .optional()
      .describe("Luau expression; the line only logs when it is true, for example \"health < 20\"."),
    realm: z
      .enum(["edit", "server", "client"])
      .default("edit")
      .describe(
        "Which DataModel to set it in. Set breakpoints in edit before starting a playtest and the running peers inherit them; name a running realm to add one to a playtest already under way.",
      ),
  })
  .superRefine((value, ctx) => {
    const need = (field: "target" | "line" | "log") => {
      if (value[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for action "${value.action}".` });
      }
    };

    if (value.action === "set") {
      need("target");
      need("line");
      // A breakpoint with nothing to log and nothing to stop for is a no-op that
      // reports success, which is the worst of both.
      need("log");
    }

    if (value.action === "remove") {
      need("target");
      need("line");
    }
  });

// ---------------------------------------------------------------------------
// Input and view
// ---------------------------------------------------------------------------

/**
 * Input goes through `UserInputService:CreateVirtualInput()`, which feeds the
 * engine's real pipeline and never touches the user's own mouse or keyboard.
 * Not `VirtualInputManager`: its Send* methods are RobloxScriptSecurity and
 * cannot work from a plugin.
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
 * Adornments live in CoreGui with the target as Adornee, so nothing is added to
 * the place and nothing needs journalling.
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

/**
 * The viewport path needs a window that is drawing and the place's Mesh/Image
 * API permission; both failures name `window` as the way round.
 */
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
 * Averaged over a span, with the worst frame reported alongside the mean: a
 * game that hitches once a second still has a good average.
 */
const perfSampleParams = z.object({
  durationMs: z.number().int().min(200).max(30000).default(3000).describe("How long to watch for."),
  includeMemory: z
    .boolean()
    .default(true)
    .describe("Break memory down by category. Slightly slower, and the only way to see which system is holding it."),
});

/**
 * Which Luau is expensive, from `ScriptProfilerService`.
 *
 * `perf.sample` answers whether the place is slow; this answers what is making
 * it slow. It only works on a running peer, because there is no game code to
 * profile in edit mode.
 */
const perfScriptParams = z.object({
  durationMs: z
    .number()
    .int()
    .min(100)
    .max(15000)
    .default(1000)
    .describe("How long to sample for. Keep it short and trigger the slow behaviour while it runs."),
  frequency: z.number().int().min(100).max(10000).default(1000).describe("Samples per second."),
  realm: z
    .enum(["server", "client"])
    .default("server")
    .describe("Which peer to profile. They run different code, so a client-side stutter is invisible from the server."),
  limit: limit(100, 20).describe("How many functions to return, most expensive first."),
  minMicroseconds: z.number().int().min(0).default(0).describe("Drop anything below this total, to cut the long tail."),
  contains: z
    .string()
    .optional()
    .describe(
      'Only functions whose name or script matches. Wrap a suspect region in debug.profilebegin("Shop:Refresh") and debug.profileend() and it appears here under that label.',
    ),
  includeEngine: z
    .boolean()
    .default(false)
    .describe("Include native engine and plugin frames. Off by default: they are not code you can change."),
});

const perfCountParams = z.object({
  scope: targetSchema.optional().describe('Subtree to count. Defaults to the whole DataModel.'),
  topClasses: limit(50, 12).describe("How many classes to list, largest first."),
  topSubtrees: limit(50, 8).describe("How many of the heaviest containers to name."),
});

/**
 * Collected from TestService's signals rather than the output buffer, so a
 * failure keeps its script and line.
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
  "dm.class_info": {
    params: classInfoParams,
    executor: "studio",
    permission: "inspect",
    capability: "inspect.datamodel",
    mutates: false,
    summary: "Describe a class: which members it has, what type each value is, and whether it can be written.",
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
  "script.replace": {
    params: scriptReplaceParams,
    executor: "studio",
    permission: "edit",
    capability: "edit.scripts",
    mutates: true,
    summary: "Replace a pattern across every script in scope, in one pass.",
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
  "run.network": {
    params: runNetworkParams,
    executor: "studio",
    permission: "playtest",
    capability: "playtest.network",
    mutates: true,
    summary: "Simulate latency, jitter, and packet loss on the playtest's network link.",
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
  "debug.breakpoints": {
    params: breakpointsParams,
    executor: "studio",
    permission: "exec",
    capability: "debug.breakpoints",
    // Studio's debugger state rather than the place: nothing to journal, and
    // nothing the user would want a Revert button beside.
    mutates: true,
    summary: "Log a line of a script every time it runs, without editing the script.",
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
  "perf.script": {
    params: perfScriptParams,
    executor: "studio",
    permission: "inspect",
    capability: "perf.script-profiler",
    mutates: false,
    summary: "Sample a running peer's Luau and report which functions the time went into.",
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
 * What each operation is called when an agent reaches it. `null` means
 * machinery rather than a tool. The `satisfies` is exhaustive on purpose: the
 * MCP list, the permission controls, and saved settings all key on these names.
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
  "dm.class_info": "studio_class_info",
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
  "script.replace": "studio_replace_in_scripts",
  "script.set": "studio_write_script",
  "script.patch": "studio_edit_script",
  "script.create": "studio_create_script",

  "run.state": "studio_run_state",
  "run.start": "studio_start_playtest",
  "run.stop": "studio_stop_playtest",
  "run.restart": "studio_restart_playtest",
  "run.wait_ready": "studio_wait_ready",
  "run.multiplayer": "studio_multiplayer_test",
  "run.network": "studio_network_conditions",

  "output.get": "studio_output",
  "output.mark": "studio_mark_output",
  "output.clear": "studio_clear_output",

  "runtime.exec": "studio_exec",
  "debug.breakpoints": "studio_breakpoints",

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
  "perf.script": "studio_profile_scripts",
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
  /** False when the window is not drawing. Input and capture both need frames. */
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
 * Whether what was just written compiles.
 *
 * Returned by every script write, because the alternative is that a missing
 * `end` is discovered by starting a playtest and reading the output — three
 * round trips to learn something the compiler knew at the moment of the write.
 * The write still happens: a script that does not compile yet is a normal state
 * to be in halfway through a change, and refusing it would make the next edit
 * impossible.
 */
export interface SyntaxCheck {
  ok: boolean;
  /** Compiler message, with the script's own name in it. Null when it compiled. */
  message: string | null;
  /** 1-based line the compiler pointed at, when it named one. */
  line: number | null;
}

/** One line a replacement changed, in both versions. */
export interface ReplaceMatch {
  line: number;
  before: string;
  after: string;
}

export interface ReplaceFile {
  instance: InstanceRef;
  replacements: number;
  /** Changed lines, up to contextLimit. */
  matches: ReplaceMatch[];
  matchesTruncated: boolean;
  syntax: SyntaxCheck | null;
}

/**
 * One member of a class, as the live engine reports it.
 *
 * `kind` separates the three things an agent can do with a name — read it, call
 * it, connect to it — because indexing an event and indexing a property look
 * identical until one of them fails.
 */
export interface ClassMember {
  name: string;
  kind: "property" | "method" | "event";
  /** Luau typeof of the value on a default instance. Null for methods and events. */
  valueType: string | null;
  /** The default value, in the same JSON format writes take. */
  value: RbxValue | null;
  /**
   * Whether a write is accepted. Null when it was not tried, which is every
   * member of a service: probing that means writing to the user's live one.
   */
  writable: boolean | null;
  /** Why the member could not be read or written, when it could not. */
  reason: string | null;
}

/** One log breakpoint Luu Code has set. */
export interface BreakpointRef {
  instance: InstanceRef;
  /** Where Studio put it, which is the next runnable line at or after the one asked for. */
  line: number;
  requestedLine: number;
  log: string | null;
  condition: string | null;
  /** False when Studio accepted it but could not bind it to running code. */
  verified: boolean;
  realm: StudioRealm;
}

export interface ProfiledFunction {
  /** The function's name, a debug.profilebegin label, or "<anonymous>". */
  name: string;
  /** Script the function was compiled from, as Roblox reports it at runtime. */
  source: string | null;
  line: number | null;
  /** Cumulative microseconds attributed to it over the capture. */
  totalMicroseconds: number;
  /** Its share of everything sampled, 0 to 1. */
  share: number;
  /** True for engine and plugin frames, which are not code the place can change. */
  engine: boolean;
}

/** The six simulation fields, read back after any write. */
export interface NetworkConditions {
  /** Round trip, both directions added together. */
  latencyMs: number;
  /** The worse of the two directions; `fields` has each on its own. */
  jitterMs: number;
  lossPercent: number;
  /** Exactly what each NetworkSettings property reads, for anything asymmetric. */
  fields: Record<string, number>;
  /** Fields this Studio build does not expose, named rather than reported as zero. */
  unavailable: string[];
}

/**
 * One step of a batch, in request order. A step that never ran is reported as
 * `skipped` rather than omitted, so the caller can see where it stopped.
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

/** One element. The rectangle is in the pixels `input.mouse` takes. */
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
   * True when a click at the centre reaches it. False with `visible` true means
   * something is covering it — see `obscuredBy`.
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
  "dm.class_info": {
    className: string;
    /** False for a service and for the abstract classes nothing can instantiate. */
    creatable: boolean;
    isService: boolean;
    /** Base classes this one satisfies, most general first. */
    ancestry: string[];
    members: ClassMember[];
    /** Names asked about that this class does not have, each with the nearest one it does. */
    unknown: Array<{ name: string; nearest: string | null }>;
  };
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
  "script.set": MutationResult & { lineCount: number; syntax: SyntaxCheck | null };
  "script.patch": MutationResult & { applied: number; lineCount: number; diff: string; syntax: SyntaxCheck | null };
  "script.create": MutationResult & { lineCount: number; syntax: SyntaxCheck | null };
  "script.replace": MutationResult & {
    files: ReplaceFile[];
    /** Replacements made, or that would be made when dryRun is on. */
    replaced: number;
    scriptsChanged: number;
    scriptsSearched: number;
    /** Scripts whose source Studio refused, skipped rather than failing the sweep. */
    unreadable: number;
    dryRun: boolean;
  };
  "script.grep": {
    files: GrepFile[];
    /** Total matches found, which exceeds the sum of what is returned when a limit cut it short. */
    matchCount: number;
    scriptsSearched: number;
    /** Scripts whose source Studio refused, skipped rather than failing the search. */
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
  "run.network": { profile: string; realm: StudioRealm; before: NetworkConditions; after: NetworkConditions };

  "output.get": { entries: OutputEntry[]; cursor: string; truncated: boolean };
  "output.mark": { cursor: string };
  "output.clear": { cleared: number };

  "runtime.exec": ExecResult;

  "debug.breakpoints": {
    /** Every breakpoint Luu Code holds in that realm after the action, not only the one just touched. */
    breakpoints: BreakpointRef[];
    removed: number;
    realm: StudioRealm;
  };

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
     * False without a LocalPlayer, edit mode included. `clickable` is then false
     * because it is unknown, not because nothing can be clicked.
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
  "perf.script": {
    realm: StudioRealm;
    durationMs: number;
    frequency: number;
    functions: ProfiledFunction[];
    /** The capture window in microseconds, which is what the shares are taken against. */
    totalMicroseconds: number;
    /** Functions the filters removed, so an empty list is explainable. */
    filtered: number;
    truncated: boolean;
  };
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
