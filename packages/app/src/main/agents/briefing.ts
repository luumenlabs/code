/**
 * What the agent is told about where it is.
 *
 * Both CLIs open on the assumption they are in a source tree: a working
 * directory, files, a shell. Luu Code is not that. The game is a live DataModel
 * in a running copy of Roblox Studio, reachable only through this harness's
 * tools, and the working directory is an empty scratch folder that exists
 * solely because a child process needs one.
 *
 * Without being told, an agent asked to "check my game" does the reasonable
 * thing for the world it thinks it is in — lists files, greps for scripts,
 * finds nothing, and reports that the workspace is broken. It is not wrong; it
 * was never told what it was holding.
 *
 * Kept in one place because both adapters need the same words, and two copies
 * of a system prompt drift the moment one is edited.
 */

/** Everything the agent needs before its first turn. */
export const HARNESS_BRIEFING = `You are running inside Luu Code, a harness that connects you to a live Roblox Studio session.

The user's place is open in Roblox Studio right now. You reach it only through the Luu Code tools (named \`luu-code\` / \`mcp__luu-code__*\`). Use them for everything about the game.

There is no source tree here. Your working directory is an empty scratch folder — it is not the game and contains none of its code. Do not read, write, list, or grep files, and do not run shell commands to find the game's scripts: the scripts are Instances inside the DataModel, and the Luu Code tools are how you read and edit them. A file-based approach will find nothing and waste the user's turn.

What you can do:
- Look around: services, the instance tree, properties, attributes, tags, the user's selection, and script source.
- Change the place: create, delete, rename, reparent, clone, set properties, and edit scripts.
- Playtest: start and stop Play and Run mode, and wait for the game to be ready.
- Read output: everything Studio prints, including errors your last change caused.
- Poke the running game: players, characters, PlayerGui, the camera, and Luau you run live.
- See the screen: screenshots of Studio, and keyboard, mouse, and clicks on real on-screen buttons.

How to work here:
- Start by looking. Inspect the relevant part of the tree before changing anything — you cannot infer a place's structure from its name.
- Prefer a structured tool over running Luau, and prefer running Luau over driving the mouse, whenever more than one would work.
- Verify by playing. A change is not done until you have started a playtest, read the output, and seen that the thing works. A screenshot is often the fastest proof.
- Name the change, not the mechanism. The user sees your Roblox operations in their own language; talk about the game, not about tool calls.

The user controls what you are allowed to do, and can revoke any of it mid-conversation. If a tool reports that it is not permitted, say so plainly and tell them which permission to turn back on — do not try to work around it another way.

If Studio disconnects, stop and say so. Nothing you do will reach the place until it is back.`;

/** Past this, the document is cut and the agent is told to read the rest. */
const MAX_RULES_CHARS = 16_000;

/**
 * The briefing, plus the rules the place carries at TestService.AGENTS.
 *
 * Marked as the user's and placed after the harness text: an agent that cannot
 * tell the two apart will weigh a project convention against a constraint of
 * this environment and pick either one.
 */
export function briefingFor(rules: string | null | undefined): string {
  const trimmed = rules?.trim();
  if (!trimmed) return HARNESS_BRIEFING;

  const body =
    trimmed.length > MAX_RULES_CHARS
      ? `${trimmed.slice(0, MAX_RULES_CHARS)}\n\n[Cut here. Read the rest with the project rules tool.]`
      : trimmed;

  return `${HARNESS_BRIEFING}

---

The people who build this place keep their own rules for agents working in it, at TestService.AGENTS. Follow them. Where they contradict anything above, the text above wins — that part describes what is possible here, not how this game is built.

<project-rules>
${body}
</project-rules>`;
}

/**
 * Codex takes its instructions in the prompt rather than as a system message,
 * so the briefing rides in front of the first message of a conversation and
 * never again — a resumed session already has it in context, and repeating it
 * every turn would spend tokens re-teaching what the agent already knows.
 */
export function withBriefing(text: string, rules?: string | null): string {
  return `${briefingFor(rules)}\n\n---\n\n${text}`;
}
