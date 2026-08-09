/**
 * Events published by the local server to the harness (and any other local
 * listener) over Server-Sent Events, plus the events the Studio plugin pushes
 * up to the server.
 */
import type { CapabilityReport } from "./capabilities.js";
import type { OutputEntry, Op } from "./commands.js";
import type { PairingRequest, RunState, SessionStatus, StudioSession } from "./session.js";
import type { WireError } from "./errors.js";
import type { InstanceRef } from "./targets.js";

/** Emitted by the plugin inside its sync request body. */
export type StudioEvent =
  | { type: "output"; entries: Array<Omit<OutputEntry, "cursor">> }
  | { type: "run"; state: RunState }
  | { type: "selection"; selection: InstanceRef[] }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

/** Emitted by the server to local UI clients. */
export type ServerEvent =
  | { type: "status"; status: SessionStatus }
  | { type: "session.connected"; session: StudioSession }
  | { type: "session.disconnected"; sessionId: string; reason: string }
  | { type: "pairing.requested"; request: PairingRequest }
  | { type: "pairing.resolved"; sessionId: string; approved: boolean }
  | { type: "run"; sessionId: string; state: RunState }
  | { type: "output"; sessionId: string; entries: OutputEntry[] }
  | { type: "capabilities"; report: CapabilityReport }
  | { type: "activity"; activity: ActivityEvent };

/**
 * A single Roblox operation, described in Roblox terms rather than protocol
 * terms. This is what the harness renders in the transcript. Spec section 33.
 */
export interface ActivityEvent {
  id: string;
  op: Op;
  /** Who issued it, so the user can tell the harness agent from an MCP client. */
  origin: "harness" | "mcp" | "internal";
  /** Human-readable summary, for example "Changed Source on ServerScriptService.Shop". */
  title: string;
  detail: string | null;
  category: "inspect" | "edit" | "playtest" | "output" | "runtime" | "visual" | "input";
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "error";
  error: WireError | null;
  /** Instances the operation touched, for click-through in the UI. */
  instances: InstanceRef[];
  /**
   * Present for screenshots so the harness can show what the agent saw in the
   * conversation, rather than leaving the user to guess. Spec section 22.
   */
  image: { data: string; mimeType: string; width: number; height: number } | null;
}
