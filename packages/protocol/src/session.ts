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

/**
 * How far a `StudioTestService` multiplayer session has got.
 *
 * `ExecuteMultiplayerTestAsync` yields for the whole life of the test, so the
 * edit peer that called it cannot answer questions about it. The phase is
 * tracked alongside instead, and is what `run.multiplayer` with action "status"
 * reports.
 */
export type MultiplayerPhase = "idle" | "starting" | "running" | "completed" | "failed";

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
  /**
   * Players present in this DataModel. Zero in Run mode and in edit, one in an
   * ordinary Play session, and however many joined a multiplayer test.
   *
   * Absent from plugins older than this field, which is why every reader treats
   * it as optional rather than defaulting it to zero: "no answer" and "no
   * players" are different things.
   */
  playerCount?: number;
  /** True when this peer belongs to a StudioTestService multiplayer session. */
  multiplayer?: boolean;
  /**
   * Whether the Studio window is drawing frames.
   *
   * A minimized window keeps running scripts but suspends rendering *and* input
   * processing, so virtual input silently does nothing and a screenshot never
   * completes. Reported so those two can fail with the real reason instead of a
   * timeout or a false success. Absent on a peer that has no render loop to
   * watch, such as a multiplayer test's server DataModel.
   */
  rendering?: boolean;
  /**
   * This DataModel asked Studio to play and the call has not returned. The only
   * evidence a playtest exists when no peer loads into it. Absent on old plugins.
   */
  pendingStart?: boolean;
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
  /** Roblox place id. 0 for a place that has never been published. */
  placeId: number;
  /** The universe the place belongs to. 0 when it belongs to none. */
  gameId: number;
  /** What to call this place. See `nameSource` for where it came from. */
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
  /**
   * Where `name` came from, because the two are not equally trustworthy.
   *
   * `published` is the name Roblox has on file for the place id, resolved
   * after the handshake. `datamodel` is `game.Name`, which is the only thing
   * available for a place that has never been published — and which Studio
   * does not keep in step with anything. A place made with File → New is
   * called "Place1" forever, whatever the file it was saved to is called, and
   * the tab title Studio shows is the file name, which no plugin API exposes.
   *
   * Absent from plugins older than this field.
   */
  nameSource?: "published" | "datamodel";
  /** The user or group that owns the experience. 0 when unpublished. */
  creatorId?: number;
  /** "User" or "Group", from `Enum.CreatorType`. */
  creatorType?: string;
  /** How many times the place has been published. */
  placeVersion?: number;
}

export type ConnectionStatus = "disconnected" | "connected" | "stale";

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
   * same place, and by every DataModel a playtest of it creates.
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
