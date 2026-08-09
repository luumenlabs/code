/**
 * The full Roblox operation surface.
 *
 * One registry drives everything downstream: server-side validation, permission
 * and capability gating, MCP tool generation, and the harness activity log. Any
 * new Studio capability is added here first.
 */
import { z } from "zod";
import type { CapabilityId, PermissionGroup } from "./capabilities.js";
import { targetSchema } from "./targets.js";
import type { InstanceDetail, InstanceRef, TreeNode } from "./targets.js";
import { rbxPropertyMapSchema, rbxValueSchema } from "./value.js";
import type { RbxValue } from "./value.js";
import type { PlaytestMode, RunState, StudioRealm } from "./session.js";

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

// ---------------------------------------------------------------------------
// Playtest
// ---------------------------------------------------------------------------

const runStateParams = z.object({});

const runStartParams = z.object({
  mode: z
    .enum(["play", "run"])
    .default("play")
    .describe(
      '"play" starts a playtest with a character and observes the client; "run" starts the place as a server with no player and observes the server.',
    ),
  waitReady: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const runStopParams = z.object({});

const runRestartParams = z.object({
  mode: z.enum(["play", "run"]).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const runWaitReadyParams = z.object({
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  requireCharacter: z.boolean().default(true),
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
  source: z.string().min(1).describe("Luau to execute in the current Studio context. The last expression or return value is sent back."),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
});

// ---------------------------------------------------------------------------
// Input and view
// ---------------------------------------------------------------------------

const inputKeyParams = z.object({
  key: z.string().min(1).describe('Enum.KeyCode name, for example "W", "Space", "E", "LeftShift".'),
  action: z.enum(["tap", "press", "release"]).default("tap"),
  durationMs: z.number().int().min(0).max(30000).default(60).describe("Hold time for tap."),
});

const inputTextParams = z.object({ text: z.string().min(1).max(2000) });

const inputMouseParams = z.object({
  action: z.enum(["move", "click", "down", "up", "scroll", "drag"]),
  x: z.number().optional().describe("Viewport pixel X, or 0-1 when normalized is true."),
  y: z.number().optional(),
  toX: z.number().optional().describe("Drag destination."),
  toY: z.number().optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  scrollDelta: z.number().default(1),
  normalized: z.boolean().default(false),
  durationMs: z.number().int().min(0).max(10000).default(80),
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

const screenshotParams = z.object({
  source: z
    .enum(["studio", "screen"])
    .default("studio")
    .describe('"studio" captures the Roblox Studio window; "screen" captures the primary display.'),
  maxWidth: z.number().int().min(160).max(4096).default(1280),
  format: z.enum(["png", "jpeg"]).default("png"),
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const statusParams = z.object({});
const capabilitiesParams = z.object({});
const sessionSelectParams = z.object({ sessionId: z.string().min(1) });

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
    summary: "Choose which connected Studio session receives commands.",
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

  "run.state": {
    params: runStateParams,
    executor: "studio",
    permission: "inspect",
    capability: null,
    mutates: false,
    summary: "Report whether the place is in edit mode or running, and which realm is observable.",
  },
  // Playtest transitions are orchestrated by the server, not by Studio: the
  // DataModel that receives the request is destroyed by it, so the connection
  // that would report the outcome is gone before it can.
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
  "view.screenshot": {
    params: screenshotParams,
    executor: "server",
    permission: "screenshot",
    capability: "view.screenshot",
    mutates: false,
    summary: "Capture the Roblox Studio window as an image.",
  },
} as const satisfies Record<string, CommandSpec>;

export type Op = keyof typeof COMMANDS;

export type CommandParams<O extends Op> = z.infer<(typeof COMMANDS)[O]["params"]>;

/** Params as callers provide them, before zod applies defaults. */
export type CommandInput<O extends Op> = z.input<(typeof COMMANDS)[O]["params"]>;

export const OPS = Object.keys(COMMANDS) as Op[];

export function isOp(value: unknown): value is Op {
  return typeof value === "string" && value in COMMANDS;
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
}

export interface ScreenshotResult {
  /** Base64 PNG or JPEG. */
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  capturedAt: number;
  source: "studio" | "screen";
}

export interface MutationResult {
  /** What the operation actually touched, so the agent can confirm the target. */
  instances: InstanceRef[];
  /** Undo waypoint name recorded in Studio, when undo history was available. */
  undoLabel: string | null;
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

  "script.list": { scripts: InstanceRef[]; truncated: boolean };
  "script.get": ScriptSourceResult;
  "script.set": MutationResult & { lineCount: number };
  "script.patch": MutationResult & { applied: number; lineCount: number; diff: string };
  "script.create": MutationResult & { lineCount: number };

  "run.state": RunState & { mode: PlaytestMode | null };
  "run.start": RunState & { ready: boolean };
  "run.stop": RunState;
  "run.restart": RunState & { ready: boolean };
  "run.wait_ready": RunState & { ready: boolean };

  "output.get": { entries: OutputEntry[]; cursor: string; truncated: boolean };
  "output.mark": { cursor: string };
  "output.clear": { cleared: number };

  "runtime.exec": ExecResult;

  "input.key": { delivered: true; key: string; action: string };
  "input.text": { delivered: true; length: number };
  "input.mouse": { delivered: true; position: { x: number; y: number } };
  "input.gui_click": GuiClickResult;
  "view.viewport_info": ViewportInfo;
  "view.screenshot": ScreenshotResult;
}

export type CommandResult<O extends Op> = CommandResults[O];
