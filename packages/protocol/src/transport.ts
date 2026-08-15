/**
 * Wire format between the Roblox Studio plugin and the local server.
 *
 * The plugin cannot open a socket, so it drives everything with HTTP requests:
 * one handshake, then a single long-polled sync endpoint that carries results
 * and events up and commands down.
 */
import type { CapabilityId } from "./capabilities.js";
import type { PlaceInfo, RunState, StudioRealm } from "./session.js";
import type { StudioEvent } from "./events.js";
import type { WireError } from "./errors.js";
import type { Op } from "./commands.js";

export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORT = 33770;
export const DEFAULT_HOST = "127.0.0.1";

/** Long-poll hold time. Kept below Roblox's HTTP timeout with margin. */
export const SYNC_HOLD_MS = 20_000;

/** A session is considered stale after this long without a sync. */
export const SESSION_STALE_MS = 45_000;

export const ROUTES = {
  hello: "/studio/hello",
  sync: "/studio/sync",
  health: "/health",
  events: "/events",
  command: "/command",
  status: "/status",
  mcp: "/mcp",
} as const;

export interface StudioHelloRequest {
  protocolVersion: number;
  /**
   * Identifies the *game*, not the window: the plugin derives it from the place
   * identity, so every Studio window on the same place presents the same one.
   * It is how a playtest's DataModels are recognised as belonging to the window
   * that started them.
   */
  installId: string;
  /**
   * Identifies the Studio window, generated fresh each time the plugin starts.
   * Plugin settings are stored once per machine, so the install id cannot tell
   * two open windows apart. Absent from older plugins, which then get one
   * window at a time.
   */
  windowId?: string;
  pluginVersion: string;
  studioVersion: string;
  place: PlaceInfo;
  capabilities: CapabilityId[];
  /** Which DataModel this plugin instance is attached to. */
  run: RunState;
}

/**
 * The handshake connects or it says why. There is no approval step: both halves
 * run on one machine as one user. The token is a session handle, quoted back on
 * every sync so a live connection can be told from a stale one.
 */
export type StudioHelloResponse =
  | {
      status: "connected";
      sessionId: string;
      /** Identifies this specific plugin connection within the session. */
      endpointId: string;
      token: string;
      /** Server-side settings the plugin should honour. */
      config: StudioRuntimeConfig;
    }
  | {
      status: "rejected";
      error: WireError;
    };

export interface StudioRuntimeConfig {
  /** How long the plugin should hold a sync request open. */
  syncHoldMs: number;
  /** Maximum output entries to batch per sync. */
  outputBatchSize: number;
  /** Whether the plugin should stream LogService output at all. */
  captureOutput: boolean;
}

export interface StudioSyncRequest {
  sessionId: string;
  endpointId: string;
  token: string;
  /**
   * True for the parked poll that waits for work; false for the push that
   * delivers results immediately. The plugin runs one of each so a result is
   * never stuck behind an open poll.
   */
  wait: boolean;
  /** Results for commands handed out by a previous sync. */
  results: StudioCommandResult[];
  events: StudioEvent[];
  run: RunState;
  /** Capability list, resent whenever it changes. */
  capabilities?: CapabilityId[];
  /**
   * The place, redescribed. The published name is a Roblox lookup, so the
   * handshake goes out with what the plugin knows locally and the better answer
   * rides the next sync. The identity is fixed for the life of a session.
   */
  place?: PlaceInfo;
}

export interface StudioSyncResponse {
  commands: StudioCommand[];
  config: StudioRuntimeConfig;
  /** Set when the server wants the plugin to re-handshake. */
  reconnect?: boolean;
}

export interface StudioCommand {
  id: string;
  op: Op;
  params: Record<string, unknown>;
  /** Wall-clock budget; the plugin gives up and reports STUDIO_TIMEOUT. */
  timeoutMs: number;
}

export type StudioCommandResult =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: WireError };

/** Body accepted by the local HTTP command endpoint used by MCP and the app. */
export interface CommandRequestBody {
  op: Op;
  params?: Record<string, unknown>;
  sessionId?: string;
  /** Force routing to a specific DataModel instead of the default for the run state. */
  realm?: StudioRealm;
  origin?: "harness" | "mcp" | "internal";
  /** The conversation this was issued for, so its activity is filed there. */
  chat?: string;
}

export type CommandResponseBody = { ok: true; data: unknown } | { ok: false; error: WireError };
