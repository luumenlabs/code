/**
 * The place's own agent rules, stored in the DataModel so they travel with the
 * game rather than with one machine.
 *
 * One location, `TestService.AGENTS`, and no search: a script named AGENTS
 * anywhere else belongs to the user. The document is a ModuleScript, so its
 * source has to compile — hence the long-string wrapper.
 */

/** The service the document lives under. */
export const RULES_PARENT = "TestService";

/** The document's name. */
export const RULES_NAME = "AGENTS";

/** The full path, for messages and for anyone implementing this elsewhere. */
export const RULES_PATH = `${RULES_PARENT}.${RULES_NAME}`;

/** Two unless the text contains a closer that would end the string early. */
function bracketLevel(text: string): number {
  let level = 2;

  for (const match of text.matchAll(/\](=*)\]/g)) {
    level = Math.max(level, (match[1]?.length ?? 0) + 1);
  }

  return level;
}

/** Wraps rules text as the source of a ModuleScript. */
export function wrapRules(text: string): string {
  const body = text.replace(/\s+$/, "");
  const equals = "=".repeat(bracketLevel(body));

  return `return [${equals}[\n${body}\n]${equals}]\n`;
}

/**
 * Reads rules text back out of a ModuleScript's source.
 *
 * Unwrapped source is returned as it stands, so a document written by hand
 * still reads. The leading newline goes because Luau drops it too.
 */
export function unwrapRules(source: string): string {
  const match = /^\s*return\s*\[(=*)\[([\s\S]*?)\]\1\]\s*$/.exec(source);

  if (!match) return source.replace(/\s+$/, "");

  return (match[2] ?? "").replace(/^\r?\n/, "").replace(/\s+$/, "");
}
