/**
 * How an operation names the instance it wants to act on. Spec sections 10.3 and 30.
 *
 * A target is a single string so agents only have to learn one concept:
 *
 *   "@h42"                              a handle returned by an earlier inspection
 *   "game.Workspace.Baseplate"          a path from the DataModel root
 *   "Workspace.Baseplate"               the leading "game." is optional
 *   'Workspace["My Part"].Handle'       bracket form for names with dots or spaces
 *
 * Handles are exact and fail loudly once the instance is gone. Paths are
 * resolved fresh on every call, which is what makes them safe to use while the
 * user is editing Studio at the same time.
 */
import { z } from "zod";

export const HANDLE_PREFIX = "@";

export const targetSchema = z
  .string()
  .min(1)
  .describe(
    'Instance to act on: a handle like "@h42" from an earlier inspection, or a DataModel path like "Workspace.Spawn.Button".',
  );

export type Target = z.infer<typeof targetSchema>;

export function isHandle(target: string): boolean {
  return target.startsWith(HANDLE_PREFIX);
}

/**
 * Splits a DataModel path into segments, honouring bracket quoting.
 * Exported because the server validates paths before sending them to Studio and
 * the harness uses the segments to render breadcrumbs.
 */
export function parsePath(path: string): string[] {
  const segments: string[] = [];
  let index = 0;
  let current = "";

  const pushCurrent = (): void => {
    if (current.length > 0) {
      segments.push(current);
      current = "";
    }
  };

  while (index < path.length) {
    const char = path[index]!;

    if (char === ".") {
      pushCurrent();
      index += 1;
      continue;
    }

    if (char === "[") {
      pushCurrent();
      const quote = path[index + 1];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`Expected a quoted name after "[" in path: ${path}`);
      }
      const closing = path.indexOf(`${quote}]`, index + 2);
      if (closing === -1) {
        throw new Error(`Unterminated bracket segment in path: ${path}`);
      }
      segments.push(path.slice(index + 2, closing));
      index = closing + 2;
      continue;
    }

    current += char;
    index += 1;
  }

  pushCurrent();

  if (segments.length > 0 && segments[0] === "game") {
    segments.shift();
  }

  return segments;
}

/** Renders segments back into a path, quoting anything that needs it. */
export function formatPath(segments: string[]): string {
  return segments.reduce<string>((acc, segment) => {
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment);
    if (acc === "") return safe ? `game.${segment}` : `game[${JSON.stringify(segment)}]`;
    return safe ? `${acc}.${segment}` : `${acc}[${JSON.stringify(segment)}]`;
  }, "");
}

/** Summary of an instance returned by every inspection operation. */
export interface InstanceRef {
  /** Handle usable as a target until the instance is destroyed. */
  handle: string;
  path: string;
  name: string;
  className: string;
  /** Number of children, so agents know whether to expand further. */
  childCount: number;
}

export interface InstanceDetail extends InstanceRef {
  parent: InstanceRef | null;
  properties: Record<string, import("./value.js").RbxValue>;
  attributes: Record<string, import("./value.js").RbxValue>;
  tags: string[];
  /** Present for scripts: source length and whether it is disabled. */
  script: ScriptSummary | null;
}

export interface ScriptSummary {
  className: "Script" | "LocalScript" | "ModuleScript" | string;
  lineCount: number;
  byteCount: number;
  disabled: boolean;
  runContext: string | null;
}

export interface TreeNode extends InstanceRef {
  children: TreeNode[];
  /** True when children were omitted because a limit was reached. */
  truncated: boolean;
}
