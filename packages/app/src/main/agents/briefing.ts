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
 * Environment only. Prescribing how to work here made every request end in a
 * playtest; that belongs in the user's own rules.
 *
 * Kept in one place because both adapters need the same words, and two copies
 * of a system prompt drift the moment one is edited.
 */

/** Everything the agent needs before its first turn. */
export const HARNESS_BRIEFING = `You are running inside Luu Code, a harness that connects you to a live Roblox Studio session.

The user's place is open in Roblox Studio right now. You reach it only through the Luu Code tools (named \`luu-code\` / \`mcp__luu-code__*\`). Use them for everything about the game.

There is no source tree here. Your working directory is an empty scratch folder — it is not the game and contains none of its code. Do not read, write, list, or grep files, and do not run shell commands to find the game's scripts: the scripts are Instances inside the DataModel, and the Luu Code tools are how you read and edit them. A file-based approach will find nothing and waste the user's turn.

What the tools reach:
- The place: services, the instance tree, properties, attributes, tags, the user's selection, and script source, all readable and writable.
- Playtesting: starting and stopping Play and Run mode, and waiting for the game to be ready.
- Studio's output, including errors your last change caused.
- The running game: players, characters, PlayerGui, the camera, and Luau you run live.
- The screen: screenshots of Studio, and keyboard, mouse, and clicks on real on-screen buttons.
- The user: \`ask_user\` puts a question, with options, into the conversation and waits for an answer. Use it where guessing wrong would waste the turn, and not for anything looking at the place would settle.

The user sees your Roblox operations described in their own language rather than as tool calls.

The user controls what you are allowed to do, and can revoke any of it mid-conversation. If a tool reports that it is not permitted, say so plainly and tell them which permission to turn back on — do not try to work around it another way.

If Studio disconnects, stop and say so. Nothing you do will reach the place until it is back.`;

/** The two layers of rules a session runs under. */
export interface AgentRules {
  /** From the app's settings. Follows the user across every place. */
  global: string | null;
  /** From TestService.AGENTS. Travels with the game. */
  place: string | null;
}

/** Past this, a document is cut and the agent is told it was. */
const MAX_RULES_CHARS = 16_000;

function section(text: string | null | undefined, tag: string, source: string): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const body =
    trimmed.length > MAX_RULES_CHARS ? `${trimmed.slice(0, MAX_RULES_CHARS)}\n\n[Cut here — ${source} is longer.]` : trimmed;

  return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * The briefing, plus whichever layers of rules exist.
 *
 * Marked as the user's and placed after the harness text: an agent that cannot
 * tell the two apart will weigh a convention against a constraint of this
 * environment and pick either one. The place's rules come last because they are
 * the more specific of the two.
 */
export function briefingFor(rules: AgentRules | null | undefined): string {
  const parts = [
    section(rules?.global, "user-rules", "the user's own rules"),
    section(rules?.place, "place-rules", "this place's rules"),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return HARNESS_BRIEFING;

  return `${HARNESS_BRIEFING}

---

Rules for working here, written by the user. Follow them. Where they contradict anything above, the text above wins — that part describes what is possible in this harness, not how anyone wants their game built. \`user-rules\` are the user's own, set in Luu Code and applying wherever they work; \`place-rules\` are this place's, kept at TestService.AGENTS and travelling with the game. Where the two disagree, the place is the more specific and wins.

${parts.join("\n\n")}`;
}

/**
 * Codex takes its instructions in the prompt rather than as a system message,
 * so the briefing rides in front of the first message of a conversation and
 * never again — a resumed session already has it in context, and repeating it
 * every turn would spend tokens re-teaching what the agent already knows.
 */
export function withBriefing(text: string, rules?: AgentRules | null): string {
  return `${briefingFor(rules)}\n\n---\n\n${text}`;
}
