/**
 * MCP tool definitions. Spec sections 21 and 23.
 *
 * The MCP surface is a first-class way to use Luu Code, not a reduced one. It
 * exposes the same operations the first-party harness uses, described so an
 * external agent can work with Roblox Studio without knowing anything about the
 * Electron app.
 *
 * The descriptions live here; the names live in the protocol's `TOOL_NAMES`,
 * beside the operations they belong to. That split is deliberate. A name is
 * part of an operation's identity — the permission controls, the settings the
 * user has saved, and the errors they read all key on it — while a description
 * is only ever read by an agent, and keeping several paragraphs of prose out of
 * the schema file leaves it readable.
 */
import { COMMANDS, TOOL_NAMES } from "@luumen/code-protocol";
import type { Op } from "@luumen/code-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface McpToolDefinition {
  name: string;
  op: Op;
  description: string;
}

/**
 * The prose, in the order an agent should meet it.
 *
 * The name is not repeated here: it comes from `TOOL_NAMES` when the list is
 * built, so there is exactly one place a tool can be renamed.
 */
const DESCRIBED: Array<{ op: Op; description: string }> = [
  {
    op: "session.status",
    description:
      "Report whether Roblox Studio is connected, which place is open, and whether it is in edit mode or a playtest. More than one Studio window can be connected at once, so this lists them all; the one you are working in is the one this conversation is bound to. Call this first if anything fails unexpectedly.",
  },
  {
    op: "session.capabilities",
    description:
      "List which Roblox capabilities are usable right now and why any are unavailable. Check this before assuming screenshots, input, or Play mode will work.",
  },
  {
    op: "session.select",
    description:
      "Move this conversation to a different connected Studio window. Every command you send afterwards goes to that window, and the one you were in is left as it is. Use studio_status to get the session id. You do not need this to start work: a conversation is bound to a window on its first command and stays there, including across a Studio restart.",
  },

  {
    op: "dm.services",
    description:
      "List the top-level services in the open place (Workspace, ReplicatedStorage, ServerScriptService, and so on) with child counts. The usual starting point for exploring an unfamiliar game.",
  },
  {
    op: "dm.get",
    description:
      "Inspect one instance: class, path, properties, attributes, tags, and immediate children. Returns a handle you can pass to later calls to act on that exact instance.",
  },
  {
    op: "dm.children",
    description: "List the children of an instance with paging. Use this instead of a deep tree when a container is large.",
  },
  {
    op: "dm.tree",
    description:
      "Read a bounded subtree of the DataModel. Prefer a small maxDepth and widen only where needed; the result reports when it was truncated.",
  },
  {
    op: "dm.search",
    description:
      "Find instances by name, class, or CollectionService tag, optionally scoped to a subtree. Faster than walking the tree when you know what you are looking for.",
  },
  {
    op: "dm.properties",
    description:
      "Read named properties from an instance. Properties Roblox refuses to read come back separately with the reason, so a missing value is never ambiguous.",
  },
  {
    op: "dm.set_properties",
    description:
      "Change properties on an instance. Values use the Luu Code JSON value format, the same shape reads return, so a value can be read and written back unchanged.",
  },
  {
    op: "dm.create",
    description: "Create an instance under a parent, optionally with properties, attributes, and tags set at creation time.",
  },
  {
    op: "dm.delete",
    description: "Destroy one or more instances. Recorded in Studio's undo history so the user can reverse it.",
  },
  { op: "dm.rename", description: "Rename an instance." },
  { op: "dm.reparent", description: "Move an instance to a different parent." },
  { op: "dm.clone", description: "Clone an instance, optionally into a different parent or under a new name." },
  {
    op: "dm.attributes.set",
    description: "Set or remove instance attributes. Pass null as a value to remove that attribute.",
  },
  { op: "dm.tags.set", description: "Add or remove CollectionService tags on an instance." },
  {
    op: "dm.batch",
    description:
      "Apply many edits in one call. Takes a list of {op, params} where op is one of studio_create_instance, studio_set_properties, studio_delete_instance, studio_rename_instance, studio_move_instance, studio_clone_instance, studio_set_attributes, or studio_set_tags — passed as their operation ids: dm.create, dm.set_properties, dm.delete, dm.rename, dm.reparent, dm.clone, dm.attributes.set, dm.tags.set. Use it whenever you are about to make the same kind of edit more than two or three times: it is one round trip instead of many, and the user gets one Ctrl+Z rather than a stack of them. Every step is validated before any of them runs, and the result says what each one did.",
  },
  {
    op: "dm.class_info",
    description:
      "Find out what a class actually has before you write to it: which properties exist, what type each one holds, what the default is, and whether Roblox will accept a write. Pass names you are unsure about in members and each one comes back either described or listed under unknown with the nearest real name — which is how a guess at CanCollide or PlaceholderText gets settled in one call instead of one rejected write at a time. The answer comes from the engine in front of you, so it is right for this Studio version rather than for the documentation's.",
  },
  {
    op: "dm.selection.get",
    description: "Read what the user currently has selected in Studio. Useful context when a request says 'this' or 'the selected part'.",
  },
  {
    op: "dm.selection.set",
    description: "Select instances in Studio so the user can see what you are working on.",
  },

  {
    op: "script.list",
    description: "List scripts in the place, optionally scoped to a subtree or filtered by script type.",
  },
  {
    op: "script.get",
    description:
      "Read a script's source from Studio, optionally a line range. Reflects unsaved editor changes, so it matches what the user sees.",
  },
  {
    op: "script.patch",
    description:
      "Apply targeted edits to a script by find/replace or line range. Prefer this over rewriting the whole file: a find that matches more than once is rejected rather than guessed at. The result says whether what you wrote compiles, and names the line if it does not.",
  },
  {
    op: "script.set",
    description:
      "Replace a script's entire source. Use studio_edit_script for anything smaller than a full rewrite. The result says whether what you wrote compiles, and names the line if it does not — check it rather than finding out from a playtest that will not start.",
  },
  {
    op: "script.create",
    description:
      "Create a Script, LocalScript, or ModuleScript with source. The result says whether the source compiles, and names the line if it does not.",
  },
  {
    op: "script.grep",
    description:
      "Search every script in the place for a pattern and get back the matching lines with their script, line, and column. This is the fastest way into an unfamiliar game: find where a remote is fired, who requires a module, or what sets a value, without reading files one at a time. Literal by default; set regex for a Luau string pattern (which is not a regular expression — use %d, %a, %w and escape magic characters with %). Scope it to a service to narrow the search.",
  },

  {
    op: "script.replace",
    description:
      "Replace a pattern across every script in scope in one pass, for a rename or an API change that touches more places than you want to edit one at a time. Matching is per line, like studio_grep_scripts, and literal by default. Run it once with dryRun to see which scripts it would touch and what each changed line would become; the same call without dryRun then applies it as a single undo step for the user, and each script gets its own entry in the change history so a bad pattern can be taken back. Nothing is written if the sweep would exceed maxReplacements or maxPerScript: half an applied rename is worse than none, because the place still builds.",
  },

  {
    op: "run.state",
    description:
      "Report whether the place is in edit mode or running, and which DataModel you are observing (edit, server, or client). Runtime state you expect to exist may simply live in the other realm.",
  },
  {
    op: "run.start",
    description:
      'Start a playtest through Studio\'s own test service. Mode "play" produces a character and a client to observe, which is what you want for GUI, input, and gameplay. Mode "run" starts the place as a server with no player, which is better for server-side logic. Waits until the session is ready by default. This does not take over the user\'s keyboard or focus their window.',
  },
  {
    op: "run.stop",
    description: "Stop the playtest and return Studio to edit mode. Returns once Studio is actually back in edit mode, not when the request was sent.",
  },
  {
    op: "run.restart",
    description: "Stop and restart the playtest. Use this after changing a server script, which a running session will not pick up.",
  },
  {
    op: "run.wait_ready",
    description: "Wait until the running experience is ready to observe, for example until the character has spawned.",
  },
  {
    op: "run.multiplayer",
    description:
      'Run a playtest with more than one client, for testing replication, ownership, and anything that only breaks with a second player. action="start" with players=N opens a server and N clients; "status" reports the phase and who has joined; "add_players" brings more in; "leave_client" removes one to test a player leaving; "end" finishes the session. Each action is sent to the DataModel that can perform it, so you do not need to reason about which peer you are on. Use studio_exec with an explicit realm to inspect either side.',
  },

  {
    op: "run.network",
    description:
      'Give the playtest a realistic connection. A Studio playtest runs the client and the server in one process with no latency between them, so replication bugs — a remote fired before the instance it names has replicated, prediction that never reconciles, two clients disagreeing about who got there first — simply do not happen there. "good" is a normal connection at 100ms, "poor" is 300ms with jitter and packet loss, and "reset" puts it back. Set it before or during a playtest, then reproduce the behaviour; pair it with studio_multiplayer_test when the bug needs a second player. The conditions read back after the write, so what actually applied is in the result.',
  },

  {
    op: "output.mark",
    description:
      "Return a cursor for the current position in Studio's output. Mark before making a change, then pass the cursor to studio_output to see only what your change produced.",
  },
  {
    op: "output.get",
    description:
      "Read Studio output including runtime errors and warnings, filtered by type and bounded by a cursor. Error entries carry the script path, line, and stack trace where Studio provides them.",
  },
  { op: "output.clear", description: "Drop buffered output." },

  {
    op: "runtime.exec",
    description:
      'Execute Luau inside Studio and return the result. Use it to inspect a runtime value, set up test state, or check an assumption the dedicated tools do not cover. During a playtest, name the realm you mean: "server" and "client" see different worlds, and a probe run in the wrong one returns a confident answer about the wrong side. The result says which realm it ran in.',
  },

  {
    op: "debug.breakpoints",
    description:
      'Watch a line of a script without editing it. Set a breakpoint with log set to a Luau expression list — \'"hp", humanoid.Health\' — and every time that line runs it writes those values to the output, where studio_output picks them up. Add a condition to hear about it only when something is wrong. This is what to use instead of adding a print: nothing is written to the user\'s place, so there is no edit to review and none to remember to take out. These never pause the game. Set them in edit before starting a playtest and the running peers inherit them; clear them when you are done, which only removes the ones you set and leaves the user\'s own alone.',
  },

  {
    op: "input.key",
    description:
      "Send a key to the running experience, for example to move the character or trigger a keybind. It goes through the engine's real input pipeline, so the character walks at its actual speed with the game's own controls, and the user's keyboard is untouched. Requires a running playtest and a Studio window that is drawing — a minimized window has its input discarded by the engine, and this reports that rather than pretending the key landed.",
  },
  {
    op: "input.text",
    description:
      "Type text into the focused TextBox in the running experience. Click the box first with studio_click_gui; with nothing focused this fails rather than typing into nowhere.",
  },
  {
    op: "input.mouse",
    description:
      "Move, click, drag, or scroll the mouse in the running experience using viewport coordinates — the same coordinates studio_screenshot returns, so you can read a position off an image and click it. Hover state follows the pointer, so a control that only responds when hovered behaves as it does for a user.",
  },
  {
    op: "input.gui_click",
    description:
      "Click a GUI element by handle or by its visible text. Resolves the element's real on-screen position first and fails with the reason when it is hidden or has no size, so a click that did nothing is never reported as success.",
  },
  {
    op: "view.viewport_info",
    description:
      "Read viewport size, GUI inset, camera state, and whether the window is drawing. Use it to convert between world, screen, and GUI coordinates, and to check why input or a screenshot is not working.",
  },
  {
    op: "view.gui",
    description:
      "Read the on-screen interface as structure rather than pixels: every element with its rectangle in viewport coordinates, its text, its draw order, and whether a click would actually reach it. Use this instead of a screenshot for any question about the UI itself — which button is where, why one is not responding, whether a panel is really hidden or just behind something. Positions come back in the same coordinates studio_mouse takes, so you can read one and click it. An element that is visible but not clickable is being covered by something, and the result names what.",
  },
  {
    op: "view.focus",
    description:
      "Point the Studio camera at an instance so a screenshot shows it. Without this a screenshot shows wherever the user last happened to be looking, which is rarely what you are working on. Pick an angle to see the side you care about, then capture. Call it again with restore to put the user's camera back where it was — it is their viewport, and leaving it somewhere else is rude.",
  },
  {
    op: "view.highlight",
    description:
      "Outline instances in the Studio viewport, so a screenshot explains itself and the user can see what you are talking about. Nothing is added to the place: the marks live outside it and vanish when cleared. Call with an empty target list to clear them. Pair it with studio_focus and studio_screenshot when you want to show, rather than describe, which thing you mean.",
  },
  {
    op: "view.screenshot",
    description:
      'Capture what the experience is rendering. The default captures the viewport from inside Studio — no ribbon, no Explorer, nothing sitting on top — and works during a playtest, which is when a screenshot is usually worth taking. Use it to judge layout, spacing, overlap, and whether a scene looks right; use structured inspection for anything a property can answer. If the place has the Mesh/Image APIs turned off, or the window is minimized, this says so and source "window" captures the desktop instead.',
  },

  {
    op: "perf.sample",
    description:
      "Measure what the engine is actually doing, over a span of seconds: frame time and the frames per second it works out to, render CPU and GPU time, physics step time, draw calls, triangles, and memory broken down by category. This is how to answer \"is it laggy, and why\" — output says nothing about frame time and a screenshot cannot show a stutter. Both the mean and the worst frame come back, because a game that hitches once a second still has a good average. Run it during a playtest; in edit mode it measures Studio drawing the place, which is a different question.",
  },
  {
    op: "perf.script",
    description:
      'Find out which Luau is expensive. studio_measure says whether the place is slow; this says what is making it slow, by sampling a running peer and reporting the functions the time went into, worst first. Name the realm: the server and the client run different code, and a stutter on one is invisible from the other. Trigger the slow behaviour while it samples, or the capture is of an idle game. If the names are too coarse to act on, wrap the suspect region in debug.profilebegin("Shop:Refresh") and debug.profileend(), run it again, and the label appears here as its own row. Engine and plugin frames are left out by default because they are not code this place can change.',
  },
  {
    op: "perf.count",
    description:
      "Take a census of the place: how many instances of each class, how many parts and scripts, and which containers hold the most. Use it when something is slow or heavy and you need to know what is actually in there before looking for the cause, or to sanity-check a generated build. Static — it does not need a playtest.",
  },

  {
    op: "test.run",
    description:
      "Run the place's TestService suite and get each result back with the script and line that reported it, rather than as text in the output buffer. Only useful in a place that already has TestService tests; if there are none it says so instead of reporting a vacuous pass.",
  },

  {
    op: "rules.get",
    description:
      "Read the rules this place carries for coding agents — the conventions, the layout, and what to avoid, written by the people who build it. They live in the place itself, at TestService.AGENTS, so they travel with the game rather than with one machine. You are given them at the start of a conversation; read them again when you want the current text, for example before adding to it.",
  },
  {
    op: "assets.search",
    description:
      "Search the Creator Store — the same catalogue Studio's Toolbox shows — for models, meshes, images, audio, or animations. Use it before building anything that already exists: a tree, a car, a lamppost, a footstep sound. Each result comes back with what an insert decision actually turns on: whether it is free, how many triangles it is, how many scripts are inside it, and how people have voted on it. A model with scripts brings someone else's code into the place, so say so rather than inserting it quietly. Pass the id to studio_insert_asset to bring it in, or use the uri for anything that goes in a property instead, like Sound.SoundId or Decal.Texture. Results are ordered by Roblox's own relevance and cannot be sorted; narrow instead, with a better query or one of the words returned under refinements.",
  },
  {
    op: "assets.info",
    description:
      "Look up store assets by id, for ids you did not get from studio_search_assets — from the web, from the user, from a URL. Same information the search returns, so you can check that something is free and see what is inside it before putting it in the place. A store URL is accepted in place of an id. Ids the store will not describe come back under missing rather than as a failure, which is what a private, deleted, or moderated asset looks like from outside.",
  },
  {
    op: "assets.insert",
    description:
      "Insert a Creator Store asset into the open place. Give it an id from studio_search_assets, or the URL of a store page. It goes into Workspace unless you name another parent, and position moves it once it is there — without one it lands wherever the asset puts itself, which is usually the origin. The result says how many instances arrived and how many of them are scripts; if it brought scripts, tell the user. It is one Ctrl+Z for them and one entry in the change history. Only free assets and ones the user already owns can be inserted; anything else is refused by Roblox rather than bought.",
  },

  {
    op: "ask.user",
    description:
      "Ask the user something and wait for the answer. The conversation turns into a form: each question appears with the options you gave, and they pick one, pick several, write their own answer, or dismiss it. Use it where guessing wrong would waste the turn — which of three shops they meant, whether to fix the model or the script that spawns it, what a vague word in the request refers to. Do not use it for anything the place can answer: look first, and ask only about what is genuinely the user's to decide. Ask everything you need in one call rather than one question per turn. Dismissing stops the turn, so treat a question as an interruption worth making, and state what you are about to do rather than asking permission to do it. This works with Studio closed.",
  },

  {
    op: "rules.set",
    description:
      "Write the place's rules for coding agents. Use it when the user tells you something about this game worth keeping — a convention, a layout decision, something not to touch. This replaces the whole document, so read it with studio_project_rules first and send the existing text back with your addition. The user sees the change and can take it back.",
  },
];

/**
 * Every tool, named from the protocol.
 *
 * An op described here that `TOOL_NAMES` gives no name to is a mistake rather
 * than something to skip past quietly: it would be a tool with prose written
 * for it that no agent can call. The exhaustiveness the other way — a named op
 * with no description — is checked by a test, because it needs to fail the
 * build rather than only the tools that happen to be listed.
 */
export const MCP_TOOLS: McpToolDefinition[] = DESCRIBED.flatMap(({ op, description }) => {
  const name = TOOL_NAMES[op];
  return name === null ? [] : [{ name, op, description }];
});

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
