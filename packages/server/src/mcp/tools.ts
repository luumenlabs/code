/**
 * MCP tool definitions. Spec sections 21 and 23.
 *
 * The MCP surface is a first-class way to use Luu Code, not a reduced one. It
 * exposes the same operations the first-party harness uses, described so an
 * external agent can work with Roblox Studio without knowing anything about the
 * Electron app.
 *
 * Names are deliberately hand-written rather than derived from op ids: an agent
 * reads them as a menu, and "studio_edit_script" says more than "script_patch".
 */
import { COMMANDS } from "@luumen/code-protocol";
import type { Op } from "@luumen/code-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface McpToolDefinition {
  name: string;
  op: Op;
  description: string;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "studio_status",
    op: "session.status",
    description:
      "Report whether Roblox Studio is connected, which place is open, and whether it is in edit mode or a playtest. Call this first if anything fails unexpectedly.",
  },
  {
    name: "studio_capabilities",
    op: "session.capabilities",
    description:
      "List which Roblox capabilities are usable right now and why any are unavailable. Check this before assuming screenshots, input, or Play mode will work.",
  },
  {
    name: "studio_select_session",
    op: "session.select",
    description: "Choose which connected Studio window receives commands when more than one is open.",
  },

  {
    name: "studio_services",
    op: "dm.services",
    description:
      "List the top-level services in the open place (Workspace, ReplicatedStorage, ServerScriptService, and so on) with child counts. The usual starting point for exploring an unfamiliar game.",
  },
  {
    name: "studio_inspect",
    op: "dm.get",
    description:
      "Inspect one instance: class, path, properties, attributes, tags, and immediate children. Returns a handle you can pass to later calls to act on that exact instance.",
  },
  {
    name: "studio_children",
    op: "dm.children",
    description: "List the children of an instance with paging. Use this instead of a deep tree when a container is large.",
  },
  {
    name: "studio_tree",
    op: "dm.tree",
    description:
      "Read a bounded subtree of the DataModel. Prefer a small maxDepth and widen only where needed; the result reports when it was truncated.",
  },
  {
    name: "studio_search",
    op: "dm.search",
    description:
      "Find instances by name, class, or CollectionService tag, optionally scoped to a subtree. Faster than walking the tree when you know what you are looking for.",
  },
  {
    name: "studio_get_properties",
    op: "dm.properties",
    description:
      "Read named properties from an instance. Properties Roblox refuses to read come back separately with the reason, so a missing value is never ambiguous.",
  },
  {
    name: "studio_set_properties",
    op: "dm.set_properties",
    description:
      "Change properties on an instance. Values use the Luu Code JSON value format, the same shape reads return, so a value can be read and written back unchanged.",
  },
  {
    name: "studio_create_instance",
    op: "dm.create",
    description: "Create an instance under a parent, optionally with properties, attributes, and tags set at creation time.",
  },
  {
    name: "studio_delete_instance",
    op: "dm.delete",
    description: "Destroy one or more instances. Recorded in Studio's undo history so the user can reverse it.",
  },
  { name: "studio_rename_instance", op: "dm.rename", description: "Rename an instance." },
  { name: "studio_move_instance", op: "dm.reparent", description: "Move an instance to a different parent." },
  { name: "studio_clone_instance", op: "dm.clone", description: "Clone an instance, optionally into a different parent or under a new name." },
  {
    name: "studio_set_attributes",
    op: "dm.attributes.set",
    description: "Set or remove instance attributes. Pass null as a value to remove that attribute.",
  },
  { name: "studio_set_tags", op: "dm.tags.set", description: "Add or remove CollectionService tags on an instance." },
  {
    name: "studio_get_selection",
    op: "dm.selection.get",
    description: "Read what the user currently has selected in Studio. Useful context when a request says 'this' or 'the selected part'.",
  },
  {
    name: "studio_set_selection",
    op: "dm.selection.set",
    description: "Select instances in Studio so the user can see what you are working on.",
  },

  {
    name: "studio_list_scripts",
    op: "script.list",
    description: "List scripts in the place, optionally scoped to a subtree or filtered by script type.",
  },
  {
    name: "studio_read_script",
    op: "script.get",
    description:
      "Read a script's source from Studio, optionally a line range. Reflects unsaved editor changes, so it matches what the user sees.",
  },
  {
    name: "studio_edit_script",
    op: "script.patch",
    description:
      "Apply targeted edits to a script by find/replace or line range. Prefer this over rewriting the whole file: a find that matches more than once is rejected rather than guessed at.",
  },
  {
    name: "studio_write_script",
    op: "script.set",
    description: "Replace a script's entire source. Use studio_edit_script for anything smaller than a full rewrite.",
  },
  { name: "studio_create_script", op: "script.create", description: "Create a Script, LocalScript, or ModuleScript with source." },

  {
    name: "studio_run_state",
    op: "run.state",
    description:
      "Report whether the place is in edit mode or running, and which DataModel you are observing (edit, server, or client). Runtime state you expect to exist may simply live in the other realm.",
  },
  {
    name: "studio_start_playtest",
    op: "run.start",
    description:
      'Start a playtest. Mode "play" produces a character and a client to observe, which is what you want for GUI, input, and gameplay. Mode "run" starts the place as a server with no player, which is better for server-side logic. Waits until the session is ready by default.',
  },
  { name: "studio_stop_playtest", op: "run.stop", description: "Stop the playtest and return Studio to edit mode." },
  {
    name: "studio_restart_playtest",
    op: "run.restart",
    description: "Stop and restart the playtest. Use this after changing a server script, which a running session will not pick up.",
  },
  {
    name: "studio_wait_ready",
    op: "run.wait_ready",
    description: "Wait until the running experience is ready to observe, for example until the character has spawned.",
  },

  {
    name: "studio_mark_output",
    op: "output.mark",
    description:
      "Return a cursor for the current position in Studio's output. Mark before making a change, then pass the cursor to studio_output to see only what your change produced.",
  },
  {
    name: "studio_output",
    op: "output.get",
    description:
      "Read Studio output including runtime errors and warnings, filtered by type and bounded by a cursor. Error entries carry the script path, line, and stack trace where Studio provides them.",
  },
  { name: "studio_clear_output", op: "output.clear", description: "Drop buffered output." },

  {
    name: "studio_exec",
    op: "runtime.exec",
    description:
      "Execute Luau inside the connected Studio session and return the result. Use it to inspect a runtime value, set up test state, or check an assumption that the dedicated tools do not cover. Runs in whichever DataModel is currently connected; the result says which.",
  },

  {
    name: "studio_press_key",
    op: "input.key",
    description: "Send a keyboard event to the running experience, for example to move the character or trigger a keybind.",
  },
  { name: "studio_type_text", op: "input.text", description: "Type text into the running experience, for example into a focused TextBox." },
  {
    name: "studio_mouse",
    op: "input.mouse",
    description: "Move, click, drag, or scroll the mouse in the running experience using viewport coordinates.",
  },
  {
    name: "studio_click_gui",
    op: "input.gui_click",
    description:
      "Click a GUI element by handle or by its visible text. Resolves the element's real on-screen position first and fails with the reason when it is hidden or has no size, so a click that did nothing is never reported as success.",
  },
  {
    name: "studio_viewport",
    op: "view.viewport_info",
    description: "Read viewport size, GUI inset, and camera state. Use it to convert between world, screen, and GUI coordinates.",
  },
  {
    name: "studio_screenshot",
    op: "view.screenshot",
    description:
      "Capture the Roblox Studio window as an image. Use it to judge layout, spacing, overlap, and whether a scene looks right; use structured inspection for anything a property can answer.",
  },
];

export function toolSchema(op: Op): Record<string, unknown> {
  const schema = zodToJsonSchema(COMMANDS[op].params, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // MCP requires an object schema; zod emits no "properties" for empty objects.
  if (schema.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  return { ...schema, properties: schema.properties ?? {} };
}

export function findTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
