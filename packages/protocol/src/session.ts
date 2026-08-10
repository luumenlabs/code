/**
 * Studio session identity, connection state, and realm tracking.
 */

/**
 * Which DataModel a plugin connection is attached to.
 *
 * Studio does not keep one stable DataModel across a playtest. Starting "Run"
 * keeps a server DataModel with no player; starting "Play" produces a client
 * DataModel where LocalPlayer and PlayerGui exist. The plugin reports which one
 * it is in so an agent never mistakes a missing LocalPlayer for a bug.
 * Spec sections 13 and 15.
 */
export type StudioRealm = "edit" | "server" | "client" | "unknown";

export type PlaytestMode = "play" | "run";

export interface RunState {
  /** True when the place is running (either Run or Play). */
  running: boolean;
  /** True while Studio is in edit mode. */
  edit: boolean;
  /** Best-effort classification of how the session was started. */
  mode: PlaytestMode | null;
  realm: StudioRealm;
  /**
   * Increments on every edit/run transition. Handles are stamped with the epoch
   * they were created in, so a runtime handle can never be replayed against an
   * edit-time instance. Spec section 30.
   */
  epoch: number;
  /** True once a LocalPlayer and character exist, where applicable. */
  ready: boolean;
}

export const EDIT_RUN_STATE: RunState = {
  running: false,
  edit: true,
  mode: null,
  realm: "edit",
  epoch: 0,
  ready: false,
};

export interface PlaceInfo {
  placeId: number;
  gameId: number;
  /** Place name as shown in Studio, or the file name for unpublished places. */
  name: string;
  /** True when the place has never been saved or published. */
  unsaved: boolean;
  /**
   * A stable identifier for this game, decided by the plugin.
   *
   * Absent when Studio has nothing durable to key on — an unpublished place
   * belonging to no universe has no id, and Studio does not expose the file it
   * was opened from. Names are deliberately not used as a fallback: two places
   * called "Baseplate" are two places, and merging them silently mixed their
   * conversations together. Also absent from plugins older than this field.
   */
  identity?: string;
}

export type ConnectionStatus = "disconnected" | "pairing" | "connected" | "stale";

/**
 * One plugin connection. A single Studio window can have more than one at a
 * time during a playtest, so commands are routed to an endpoint rather than to
 * a session.
 */
export interface StudioEndpoint {
  id: string;
  realm: StudioRealm;
  run: RunState;
  /** Epoch milliseconds of the last successful sync. */
  lastSeen: number;
  /** True when a sync request is currently parked, waiting for commands. */
  polling: boolean;
}

export interface StudioSession {
  /** Stable id for this Studio window, held for as long as the window is open. */
  id: string;
  /**
   * Identifies the game this window has open. Shared by every window on the
   * same place, because it is what the pairing approval is remembered against.
   */
  installId: string;
  /**
   * Identifies the Studio window itself. Two windows on the same place share an
   * install id and differ only here.
   */
  windowId: string;
  place: PlaceInfo;
  studioVersion: string;
  pluginVersion: string;
  status: ConnectionStatus;
  /** Live plugin connections, ordered most recently seen first. */
  endpoints: StudioEndpoint[];
  /** Run state of the endpoint commands are currently routed to. */
  run: RunState;
  lastSeen: number;
  /** True when this session is the default target for callers naming no other. */
  active: boolean;
}

export interface PairingRequest {
  sessionId: string;
  installId: string;
  windowId: string;
  code: string;
  place: PlaceInfo;
  studioVersion: string;
  pluginVersion: string;
  requestedAt: number;
  expiresAt: number;
}

export interface SessionStatus {
  serverVersion: string;
  /** All Studio sessions the server currently knows about. */
  sessions: StudioSession[];
  /**
   * Default target for a caller that names neither a session nor a chat, and
   * the session a new chat is bound to on its first command.
   */
  activeSessionId: string | null;
  /**
   * Which Studio session each chat is working in, keyed by chat id.
   *
   * A chat sticks to the window it started in. Several agents run at once, so a
   * single moving target would let one chat's edits land in whichever place the
   * user happened to have selected.
   */
  chats: Record<string, string>;
  /** Pairing requests waiting for user approval. */
  pending: PairingRequest[];
}

/**
 * Deterministic endpoint selection.
 *
 * Preferring the most recent connection would flap between two long-polling
 * plugin instances, so realm order decides instead: during a playtest the
 * client DataModel is where GUI, camera, and input live, and it is what an
 * agent almost always wants to observe.
 */
export function selectEndpoint(session: StudioSession, preferred?: StudioRealm): StudioEndpoint | null {
  if (session.endpoints.length === 0) return null;
  if (preferred) {
    return session.endpoints.find((endpoint) => endpoint.realm === preferred) ?? null;
  }

  const order: StudioRealm[] = session.run.running ? ["client", "server", "unknown", "edit"] : ["edit", "server", "client", "unknown"];
  for (const realm of order) {
    const match = session.endpoints.find((endpoint) => endpoint.realm === realm);
    if (match) return match;
  }
  return session.endpoints[0] ?? null;
}
