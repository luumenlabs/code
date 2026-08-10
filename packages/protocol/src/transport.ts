/**
 * Wire format between the Roblox Studio plugin and the local server.
 *
 * The plugin cannot open a socket, so it drives everything with HTTP requests:
 * one handshake, one pairing call, then a single long-polled sync endpoint that
 * carries results and events up and commands down.
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
  pair: "/studio/pair",
  sync: "/studio/sync",
  health: "/health",
  events: "/events",
  command: "/command",
  status: "/status",
  pairing: "/pairing",
  mcp: "/mcp",
} as const;

export interface StudioHelloRequest {
  protocolVersion: number;
  installId: string;
  pluginVersion: string;
  studioVersion: string;
  place: PlaceInfo;
  capabilities: CapabilityId[];
  /** Which DataModel this plugin instance is attached to. */
  run: RunState;
  /** Token from a previous pairing, if the plugin still has one. */
  token?: string;
}

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
      status: "pairing";
      sessionId: string;
      /** Six digits the user compares against the harness before approving. */
      pairingCode: string;
      expiresAt: number;
    }
  | {
      status: "rejected";
      error: WireError;
    };

export interface StudioPairRequest {
  sessionId: string;
  installId: string;
}

export type StudioPairResponse =
  | { status: "connected"; endpointId: string; token: string; config: StudioRuntimeConfig }
  | { status: "pending" }
  | { status: "rejected"; error: WireError };

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
