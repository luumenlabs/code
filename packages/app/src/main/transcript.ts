/**
 * Turns agent and server events into persisted transcript entries.
 *
 * The main process owns this, not the renderer: what gets written to disk and
 * what the user sees have to be the same thing, and having two builders would
 * guarantee they eventually diverge.
 */
import type { ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, TranscriptEntry } from "../shared/agent.js";

/** Luu Code's own tools appear as Roblox activity, not as raw tool rows. */
const ROBLOX_TOOL_PREFIX = "mcp__luu-code__";

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

export function userEntry(text: string): TranscriptEntry {
  return { kind: "user", id: nextId("u"), at: Date.now(), text };
}

export function fromAgentEvent(event: AgentEvent, existing: (id: string) => TranscriptEntry | null): TranscriptEntry | null {
  switch (event.type) {
    case "assistant":
      return { kind: "assistant", id: event.id, at: Date.now(), text: event.text };

    case "thinking":
      return { kind: "thinking", id: event.id, at: Date.now(), text: event.text };

    case "tool-use":
      if (event.name.startsWith(ROBLOX_TOOL_PREFIX)) return null;
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
      // A result for a Roblox tool has no row to attach to, by design.
      if (!previous || previous.kind !== "tool") return null;
      return { ...previous, result: event.text, isError: event.isError };
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
