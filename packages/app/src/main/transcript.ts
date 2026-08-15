/**
 * Turns agent and server events into persisted transcript entries. The main
 * process owns this: what is written to disk and what the user sees are one
 * thing.
 */
import { OPS, toolNameFor } from "@luumen/code-protocol";
import type { Op, ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, Attachment, TranscriptEntry } from "../shared/agent.js";

/**
 * Luu Code's own tools appear as Roblox activity, not as raw tool rows. Matched
 * on two signals: Claude Code's MCP client produces `mcp__luu-code__`, and a
 * Codex build may report the tool without its server.
 *
 * `ask_user` is not one of them — it performs no Roblox operation, so there is
 * no activity row for it to duplicate.
 */
function isRobloxTool(name: string): boolean {
  const op = opForTool(name);
  if (op === "ask.user") return false;

  return name.includes("luu-code") || op !== null;
}

/**
 * The operation an MCP tool name stands for. Built from the protocol's own
 * table, so an op renamed in `commands.ts` cannot leave a stale guess here. The
 * last segment is matched: a CLI may or may not prefix the server name.
 */
const OP_BY_TOOL = new Map<string, Op>(
  OPS.flatMap((op) => {
    const tool = toolNameFor(op);
    return tool ? [[tool, op] as const] : [];
  }),
);

function opForTool(name: string): Op | null {
  const last = name.split("__").filter(Boolean).at(-1) ?? name;
  return OP_BY_TOOL.get(last) ?? null;
}

/**
 * What the thread already holds, for the two questions this builder has to ask
 * about entries it did not create.
 */
export interface TranscriptView {
  byId(id: string): TranscriptEntry | null;
  /** Whether a Roblox operation for `op` has already been filed since `since`. */
  hasActivity(op: Op, since: number): boolean;
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
 * How far before the call an activity may have started and still be its own.
 * The two clocks are the app's and the server's, so a few hundred milliseconds
 * either way is ordinary.
 */
const ACTIVITY_SLACK_MS = 1_000;

/**
 * Roblox calls that were suppressed, kept until their result arrives. A
 * suppressed call that fails performed no operation, so its row has to carry
 * the name and arguments the result event does not repeat. Bounded: a CLI that
 * never reports a result would grow this for the life of the process.
 */
const SUPPRESSED_LIMIT = 200;
const suppressed = new Map<string, { name: string; input: unknown; at: number }>();

function remember(id: string, call: { name: string; input: unknown; at: number }): void {
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

export function fromAgentEvent(event: AgentEvent, view: TranscriptView): TranscriptEntry | null {
  switch (event.type) {
    case "assistant":
      return { kind: "assistant", id: event.id, at: Date.now(), text: event.text };

    case "thinking":
      return { kind: "thinking", id: event.id, at: Date.now(), text: event.text };

    case "tool-use":
      if (isRobloxTool(event.name)) {
        remember(event.id, { name: event.name, input: event.input, at: Date.now() });
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
      const previous = view.byId(event.id);
      if (previous && previous.kind === "tool") return { ...previous, result: event.text, isError: event.isError };

      const call = suppressed.get(event.id);
      suppressed.delete(event.id);

      // A Roblox tool has no row of its own; its work appears as the operation
      // it performed. A call that fails before reaching Studio performs none,
      // so without this it vanishes. When the operation did run and failed, the
      // server already filed that as an activity — the op tells the two apart.
      const op = call ? opForTool(call.name) : null;
      if (op && call && view.hasActivity(op, call.at - ACTIVITY_SLACK_MS)) return null;

      // A tool row rather than a notice: a notice is a full-width banner, and a
      // turn that retries a call three times would paint the conversation in them.
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
