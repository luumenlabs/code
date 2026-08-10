/**
 * The normalized shape of a coding-agent session.
 *
 * Claude Code and Codex speak different stream formats, and future agents will
 * speak others. Those differences are absorbed by the adapters so nothing
 * downstream, and nothing on the Roblox side, has to know which agent is
 * running. Spec sections 6 and 38.
 */

export type AgentId = "claude" | "codex";

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Resolved executable path, or null when it was not found. */
  command: string | null;
  version: string | null;
  installed: boolean;
  /** Why the agent cannot be used, phrased for the user. Spec section 44. */
  problem: string | null;
  installHint: string;
  /**
   * The newest published version, or null when the registry could not be
   * reached. Null is not "up to date" — it is "unknown", and reads that way.
   */
  latestVersion?: string | null;
  /** How this install updates itself, which depends on how it was installed. */
  updateCommand?: string | null;
}

/**
 * An image the user attached to a message.
 *
 * Screenshots are how people describe a Roblox problem — a broken GUI, a part
 * in the wrong place — so the composer takes them directly. Carried as base64
 * because that is what both the SDK and the transcript need, and neither should
 * depend on a file still being on disk later.
 */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  /** Base64, without the data-URL prefix. */
  data: string;
}

export type AgentState = "idle" | "starting" | "thinking" | "working" | "stopped" | "error";

export type AgentEvent =
  | { type: "session"; sessionId: string; model: string | null }
  | { type: "assistant"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool-use"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; isError: boolean; text: string }
  | { type: "state"; state: AgentState; message?: string }
  | { type: "turn-complete"; summary: string | null }
  | { type: "error"; message: string };

/**
 * One rendered, persisted transcript entry.
 *
 * Roblox operations are part of the transcript, not a separate log: reopening a
 * conversation should show what the agent actually did to the place, not just
 * what it said about it. Spec sections 33 and 45.
 */
export type TranscriptEntry =
  | { kind: "user"; id: string; text: string; at: number; attachments?: Attachment[] }
  | { kind: "assistant"; id: string; text: string; at: number }
  | { kind: "thinking"; id: string; text: string; at: number }
  | { kind: "tool"; id: string; name: string; input: unknown; result: string | null; isError: boolean; at: number }
  | { kind: "activity"; id: string; at: number; activity: import("@luumen/code-protocol").ActivityEvent }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error"; at: number };

export interface AgentSessionSnapshot {
  agent: AgentId | null;
  state: AgentState;
  sessionId: string | null;
  model: string | null;
  message: string | null;
}
