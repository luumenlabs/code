/**
 * What a tool call is, in a line: a verb and its object — "Edit ·
 * ModelChip.tsx", "Ran · pnpm check". The whole call is still one click away.
 *
 * A Roblox operation never reaches here; it arrives as an `ActivityEvent`.
 * Everything else is a name and a bag of JSON, and an unknown tool is the
 * normal case, so the generic branch is written as carefully as the named ones.
 */

export interface ToolSummary {
  /** The verb. Short enough to never wrap. */
  label: string;
  /** What it acted on, or "" when the label already says everything. */
  detail: string;
  /** Which glyph to draw, resolved to a component by the caller. */
  icon: ToolGlyph;
}

export type ToolGlyph =
  | "read"
  | "edit"
  | "shell"
  | "search"
  | "files"
  | "web"
  | "plan"
  | "agent"
  | "mcp"
  | "tool";

type Args = Record<string, unknown>;

function args(input: unknown): Args {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Args) : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * A path as someone reading the transcript thinks of it. The parent is kept
 * because `index.ts` on its own names nothing.
 */
export function shortPath(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return value;

  return parts.slice(-2).join("/");
}

/** The first line of a command, so a heredoc does not become the label. */
function firstLine(value: string): string {
  const line = value.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.trim();
}

/**
 * The generic summary: the arguments that carry meaning, as `key: value`.
 * Objects and arrays are left out; the open row has them in full.
 */
function describeArgs(input: unknown): string {
  const entries = Object.entries(args(input))
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => `${key}: ${text(value)}`)
    .filter((entry) => !entry.endsWith(": "));

  return entries.slice(0, 3).join(" · ");
}

/** `mcp__luu-code__studio_start_playtest` → `studio start playtest`. */
function mcpToolName(name: string): { server: string; tool: string } {
  const parts = name.split("__").filter(Boolean);
  return { server: parts[1] ?? "mcp", tool: (parts[2] ?? parts[1] ?? name).replace(/_/g, " ") };
}

export function describeTool(name: string, input: unknown): ToolSummary {
  const fields = args(input);
  const path = text(fields.file_path ?? fields.filePath ?? fields.path ?? fields.notebook_path);

  switch (name) {
    case "Read":
    case "NotebookRead": {
      const offset = text(fields.offset);
      const limit = text(fields.limit);
      const range = offset && limit ? ` (${offset}–${Number(offset) + Number(limit)})` : "";
      return { label: "Read", detail: path ? `${shortPath(path)}${range}` : "", icon: "read" };
    }

    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { label: "Edit", detail: path ? shortPath(path) : "", icon: "edit" };

    case "Write":
      return { label: "Write", detail: path ? shortPath(path) : "", icon: "edit" };

    case "Bash":
    case "PowerShell":
    case "shell": {
      const command = firstLine(text(fields.command) || text(input));
      return { label: "Ran", detail: command, icon: "shell" };
    }

    case "Grep":
      return { label: "Searched", detail: text(fields.pattern), icon: "search" };

    case "Glob":
      return { label: "Found files", detail: text(fields.pattern), icon: "files" };

    case "WebFetch":
      return { label: "Fetched", detail: text(fields.url), icon: "web" };

    case "WebSearch":
      return { label: "Searched the web", detail: text(fields.query), icon: "web" };

    case "TodoWrite":
      return { label: "Updated the plan", detail: "", icon: "plan" };

    case "Task":
    case "Agent":
      return { label: "Delegated", detail: text(fields.description) || text(fields.subagent_type), icon: "agent" };

    default:
      break;
  }

  if (name.startsWith("mcp__")) {
    const { server, tool } = mcpToolName(name);
    const detail = describeArgs(input);
    // The server is named: "read instance" means one thing from Luu Code and
    // another from whatever else the user has connected.
    return { label: tool, detail: detail ? `${server} · ${detail}` : server, icon: "mcp" };
  }

  return { label: name, detail: describeArgs(input), icon: "tool" };
}
