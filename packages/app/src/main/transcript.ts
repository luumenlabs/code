/**
 * Turns agent and server events into persisted transcript entries.
 *
 * The main process owns this, not the renderer: what gets written to disk and
 * what the user sees have to be the same thing, and having two builders would
 * guarantee they eventually diverge.
 */
import type { ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, Attachment, TranscriptEntry } from "../shared/agent.js";

/**
 * Luu Code's own tools appear as Roblox activity, not as raw tool rows.
 *
 * Matched by two signals rather than one exact prefix. `mcp__luu-code__` is the
 * name Claude Code's MCP client produces; a Codex build that reports the tool
 * without its server does not carry it, and those calls were showing up twice —
 * once as the Roblox operation the server reported, and once as a raw row with
 * `{}` for arguments. Every tool this server exposes is `studio_*`, so the tool
 * name alone is enough to recognise one.
 */
function isRobloxTool(name: string): boolean {
  return name.includes("luu-code") || /(^|__)studio_[a-z_]+$/.test(name);
}

export interface TranscriptSink {
  /** Insert or replace by entry id. */
  upsert(entry: TranscriptEntry): void;
  /** The coding agent reported its own session id, which makes resume possible. */
  session(sessionId: string): void;
}

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${Date.now().toString(36)}`;
}

/**
 * Roblox calls that were suppressed, kept until their result arrives.
 *
 * A suppressed call that then fails still has to be shown — it performed no
 * operation, so nothing else in the transcript accounts for it — and the only
 * readable way to show it is as the call it was. That means remembering the
 * name and arguments the row would have carried, because the result event does
 * not repeat them.
 *
 * Bounded, because a CLI that never reports a result for a call would otherwise
 * grow this for the life of the process.
 */
const SUPPRESSED_LIMIT = 200;
const suppressed = new Map<string, { name: string; input: unknown }>();

function remember(id: string, call: { name: string; input: unknown }): void {
  if (suppressed.size >= SUPPRESSED_LIMIT) {
    const oldest = suppressed.keys().next().value;
    if (oldest !== undefined) suppressed.delete(oldest);
  }
  suppressed.set(id, call);
}

export function userEntry(text: string, attachments: Attachment[] = []): TranscriptEntry {
  return {
    kind: "user",
    id: nextId("u"),
    at: Date.now(),
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function fromAgentEvent(event: AgentEvent, existing: (id: string) => TranscriptEntry | null): TranscriptEntry | null {
  switch (event.type) {
    case "assistant":
      return { kind: "assistant", id: event.id, at: Date.now(), text: event.text };

    case "thinking":
      return { kind: "thinking", id: event.id, at: Date.now(), text: event.text };

    case "tool-use":
      if (isRobloxTool(event.name)) {
        remember(event.id, { name: event.name, input: event.input });
        return null;
      }

      return {
        kind: "tool",
        id: event.id,
        at: Date.now(),
        name: event.name,
        input: event.input,
        result: null,
        isError: false,
      };

    case "tool-result": {
      const previous = existing(event.id);
      if (previous && previous.kind === "tool") return { ...previous, result: event.text, isError: event.isError };

      const call = suppressed.get(event.id);
      suppressed.delete(event.id);

      // A Roblox tool has no row of its own, by design — its work appears as
      // the operation it performed. But a call that fails performs nothing, so
      // it produces no operation either, and without this the whole thing
      // vanishes: the user sees the agent say it could not reach Studio, with
      // nothing in the transcript to say why.
      //
      // It surfaces as the tool row it would have been rather than as a notice.
      // A notice is a banner — full width, red, unfoldable — and a turn that
      // retries a call three times painted the conversation in them. The row
      // says the same thing in one line and keeps the reason one click away.
      if (event.isError && event.text.trim().length > 0) {
        return {
          kind: "tool",
          id: event.id,
          at: Date.now(),
          name: call?.name ?? "Roblox operation",
          input: call?.input ?? null,
          result: event.text,
          isError: true,
        };
      }

      return null;
    }

    case "error":
      return { kind: "notice", id: nextId("n"), at: Date.now(), text: event.message, tone: "error" };

    case "state":
      if (event.state === "stopped" && event.message) {
        return { kind: "notice", id: nextId("n"), at: Date.now(), text: event.message, tone: "info" };
      }
      return null;

    default:
      return null;
  }
}

export function fromServerEvent(event: ServerEvent): TranscriptEntry | null {
  if (event.type !== "activity") return null;
  return { kind: "activity", id: event.activity.id, at: event.activity.startedAt, activity: event.activity };
}
