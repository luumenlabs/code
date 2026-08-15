/** Studio session registry: connection lifecycle and command routing. */
import { randomUUID } from "node:crypto";
import {
  LuuCodeError,
  SESSION_STALE_MS,
  SYNC_HOLD_MS,
  selectEndpoint,
} from "@luumen/code-protocol";
import type {
  CapabilityId,
  Op,
  PlaceInfo,
  RunState,
  SessionStatus,
  StudioCommand,
  StudioEndpoint,
  StudioHelloRequest,
  StudioHelloResponse,
  StudioRealm,
  StudioRuntimeConfig,
  StudioSession,
  StudioSyncRequest,
  StudioSyncResponse,
} from "@luumen/code-protocol";
import { generateToken, safeEquals } from "./auth.js";
import { EventBus } from "./events.js";
import { defer } from "../util/defer.js";
import type { Deferred } from "../util/defer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("sessions");

const SWEEP_INTERVAL_MS = 5_000;

/**
 * How long a connection may go quiet before it stops counting as live. The
 * plugin re-sends its long poll at least every SYNC_HOLD_MS, so anything past
 * one hold is a DataModel that has gone. Shorter than SESSION_STALE_MS.
 */
const ENDPOINT_LIVE_MS = SYNC_HOLD_MS + 10_000;

/**
 * How long a newly connected playtest peer is safe from an edit peer reporting
 * no playtest. Covers one edit sync composed before the transition and
 * delivered after it. See dropFinishedRuntimePeers.
 */
const RUNTIME_PEER_GRACE_MS = 5_000;

interface PendingCommand {
  op: Op;
  deferred: Deferred<unknown>;
  timer: NodeJS.Timeout;
}

interface EndpointRecord {
  id: string;
  sessionId: string;
  realm: StudioRealm;
  run: RunState;
  lastSeen: number;
  /** First handshake, which orders the clients of a multiplayer test. */
  connectedAt: number;
  capabilities: Set<CapabilityId>;
  queue: StudioCommand[];
  pending: Map<string, PendingCommand>;
  /** The parked long poll, if one is currently open. */
  park: Deferred<StudioSyncResponse> | null;
  parkTimer: NodeJS.Timeout | null;
}

interface SessionRecord {
  id: string;
  installId: string;
  windowId: string;
  token: string;
  place: StudioSession["place"];
  studioVersion: string;
  pluginVersion: string;
  endpoints: Map<string, EndpointRecord>;
  lastSeen: number;
  connectedAt: number;
}

/**
 * Which Studio window a caller means. An explicit session id wins, then the
 * chat, since chats run concurrently in different places. A caller with neither
 * falls back to the default.
 */
export interface SessionTarget {
  sessionId?: string;
  chat?: string;
}

/**
 * What a chat is working in. The session id alone would not survive Studio
 * restarting, so the install id and place identity are recorded too and the
 * same game is recognised when it returns.
 */
interface ChatBinding {
  sessionId: string;
  installId: string;
  identity: string | null;
  placeName: string;
}

export interface SessionEvents {
  onOutput(sessionId: string, entries: Array<Record<string, unknown>>): void;
  onRunState(sessionId: string, state: RunState): void;
}

/**
 * One live plugin connection, named well enough to send a command straight to
 * it. Studio runs the plugin separately in the edit DataModel and in each one a
 * playtest creates, and only some of them can serve a given operation.
 */
export interface PeerRef {
  sessionId: string;
  endpointId: string;
  realm: StudioRealm;
  run: RunState;
  /** First handshake, which is what gives "client 2" a stable meaning. */
  connectedAt: number;
  /**
   * What this connection can serve, which is not decided by its realm alone: a
   * playtest's server reports the client's capabilities too, because it can
   * forward to it.
   */
  capabilities: Set<CapabilityId>;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Window id to session id, so a re-handshake finds its own session. */
  private readonly byWindow = new Map<string, string>();
  private readonly chats = new Map<string, ChatBinding>();
  private activeSessionId: string | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly hooks: SessionEvents,
    private readonly serverVersion: string,
  ) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    for (const session of this.sessions.values()) {
      for (const endpoint of session.endpoints.values()) {
        this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "The local server is shutting down"));
      }
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  /**
   * Connects, every time. There is no approval step: both ends are one program
   * on one machine. The token is issued and checked on every sync, which is
   * what tells a live connection from a stale one.
   */
  hello(request: StudioHelloRequest): StudioHelloResponse {
    const windowId = windowIdOf(request);

    // A window that has handshaked before keeps its session, so a plugin
    // reloading does not strand the chats bound to it. A playtest's DataModel
    // joins the window that started it rather than opening one of its own.
    const sessionId = this.byWindow.get(windowId) ?? this.sessionForRuntimePeer(request) ?? `s_${randomUUID().slice(0, 8)}`;
    const token = this.sessions.get(sessionId)?.token ?? generateToken();

    const session = this.upsertSession(sessionId, request, windowId, token);
    const endpoint = this.addEndpoint(session, request.run, request.capabilities);

    // The window that just connected is the clearest statement of which Studio
    // a caller naming none means.
    this.activeSessionId = session.id;

    log.info(`Studio connected: ${request.place.name} (${endpoint.realm})`);
    this.bus.emit({ type: "session.connected", session: this.toPublicSession(session) });
    this.emitStatus();

    return {
      status: "connected",
      sessionId: session.id,
      endpointId: endpoint.id,
      token: session.token,
      config: this.runtimeConfig(session),
    };
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async sync(request: StudioSyncRequest): Promise<StudioSyncResponse> {
    const session = this.sessions.get(request.sessionId);

    if (!session || !safeEquals(session.token, request.token ?? "")) {
      throw new LuuCodeError("UNAUTHORIZED", "This Studio connection is not registered with the local server.");
    }

    const endpoint = session.endpoints.get(request.endpointId);
    if (!endpoint) {
      throw new LuuCodeError("SESSION_UNKNOWN", "This Studio connection is no longer registered. Reconnect.");
    }

    const now = Date.now();
    endpoint.lastSeen = now;
    session.lastSeen = now;

    if (request.capabilities) {
      endpoint.capabilities = new Set(request.capabilities);
    }

    this.applyResults(endpoint, request);
    this.applyPlace(session, request.place);
    this.applyRunState(session, endpoint, request.run);
    this.applyEvents(session, request);

    if (endpoint.queue.length > 0 || request.wait === false) {
      return this.drainQueue(endpoint, session);
    }

    return this.park(endpoint, session);
  }

  private applyResults(endpoint: EndpointRecord, request: StudioSyncRequest): void {
    for (const result of request.results ?? []) {
      const pending = endpoint.pending.get(result.id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      endpoint.pending.delete(result.id);

      if (result.ok) {
        pending.deferred.resolve(result.data);
      } else {
        pending.deferred.reject(LuuCodeError.from(result.error));
      }
    }
  }

  /**
   * The same game, described better. The plugin resolves the published place
   * name after the handshake, so the first description is often `game.Name`.
   * Only the description may move — a different identity is a different game,
   * and a session that changed which place it stood for would relabel every
   * chat bound to it.
   *
   * Compared field by field, not by serialising: the plugin builds this from a
   * Lua table whose key order is whatever the hash gave.
   */
  private applyPlace(session: SessionRecord, place: PlaceInfo | undefined): void {
    if (!place) return;
    if ((place.identity ?? null) !== (session.place.identity ?? null)) return;
    if (samePlace(place, session.place)) return;

    session.place = place;
    this.emitStatus();
  }

  private applyRunState(session: SessionRecord, endpoint: EndpointRecord, run: RunState | undefined): void {
    if (!run) return;

    const changed = endpoint.run.running !== run.running || endpoint.run.ready !== run.ready || endpoint.run.realm !== run.realm;

    endpoint.run = run;
    endpoint.realm = run.realm;

    if (changed) {
      this.hooks.onRunState(session.id, run);
      this.bus.emit({ type: "run", sessionId: session.id, state: run });
      this.emitStatus();
    }

    // An edit peer saying no test is active settles it for the whole window, and
    // it is the only peer that reliably outlives a playtest to say so.
    if (run.testActive === false && !run.running) {
      this.dropFinishedRuntimePeers(session, endpoint);
    }
  }

  /**
   * Drops connections left over from a playtest that has ended.
   *
   * Studio does not always close their sockets promptly, and until it does they
   * keep claiming `running` — which `selectEndpoint` prefers, so the window goes
   * on reporting a playtest for up to a staleness window after leaving one, and
   * commands route to a DataModel that no longer exists.
   */
  private dropFinishedRuntimePeers(session: SessionRecord, edit: EndpointRecord): void {
    let dropped = false;

    for (const [id, other] of session.endpoints) {
      if (other === edit || !other.run.running) continue;

      // A peer that has only just connected is more likely the playtest this
      // edit sync was composed too early to have noticed than a leftover from
      // one that ended. The edit peer polls in fractions of a second, so a
      // report this stale is only ever in flight across the transition itself.
      if (Date.now() - other.connectedAt < RUNTIME_PEER_GRACE_MS) continue;

      log.info(`Playtest ended; dropping its ${other.realm} connection`);
      this.failEndpoint(other, new LuuCodeError("STUDIO_NOT_CONNECTED", "The playtest this connection belonged to has ended."));
      session.endpoints.delete(id);
      dropped = true;
    }

    if (dropped) this.announce(session);
  }

  private applyEvents(session: SessionRecord, request: StudioSyncRequest): void {
    for (const event of request.events ?? []) {
      if (event.type === "output") {
        this.hooks.onOutput(session.id, event.entries as unknown as Array<Record<string, unknown>>);
      } else if (event.type === "log") {
        log.debug(`studio: ${event.message}`);
      }
    }
  }

  private drainQueue(endpoint: EndpointRecord, session: SessionRecord): StudioSyncResponse {
    const commands = endpoint.queue;
    endpoint.queue = [];
    return { commands, config: this.runtimeConfig(session) };
  }

  private park(endpoint: EndpointRecord, session: SessionRecord): Promise<StudioSyncResponse> {
    // Only one poll may be parked per endpoint. A second one usually means the
    // plugin reconnected without us noticing, so the older poll is released.
    if (endpoint.park) {
      endpoint.park.resolve({ commands: [], config: this.runtimeConfig(session) });
      if (endpoint.parkTimer) clearTimeout(endpoint.parkTimer);
    }

    const parked = defer<StudioSyncResponse>();
    endpoint.park = parked;

    endpoint.parkTimer = setTimeout(() => {
      endpoint.park = null;
      endpoint.parkTimer = null;
      parked.resolve({ commands: [], config: this.runtimeConfig(session) });
    }, SYNC_HOLD_MS);
    endpoint.parkTimer.unref?.();

    return parked.promise;
  }

  private release(endpoint: EndpointRecord): void {
    if (!endpoint.park) return;

    const session = this.sessions.get(endpoint.sessionId);
    const parked = endpoint.park;
    const timer = endpoint.parkTimer;

    endpoint.park = null;
    endpoint.parkTimer = null;
    if (timer) clearTimeout(timer);

    const commands = endpoint.queue;
    endpoint.queue = [];
    parked.resolve({ commands, config: session ? this.runtimeConfig(session) : defaultRuntimeConfig() });
  }

  // -------------------------------------------------------------------------
  // Command routing
  // -------------------------------------------------------------------------

  /**
   * Sends a command to Studio and waits for its result.
   *
   * Rejects with a typed error when Studio is not connected, when the requested
   * realm has no connection, or when the command outlives its budget.
   */
  async send(
    op: Op,
    params: Record<string, unknown>,
    options: SessionTarget & { realm?: StudioRealm; peer?: PeerRef; capability?: CapabilityId | null; timeoutMs: number },
  ): Promise<unknown> {
    const session = options.peer ? this.requireSession(options.peer.sessionId) : this.resolveSession(options);
    const endpoint = options.peer
      ? this.requireEndpoint(session, options.peer.endpointId)
      : this.resolveEndpoint(session, options.realm, options.capability);

    // Bound here rather than at resolution, so a chat is pinned by the first
    // command it sends and not by a status probe. A command aimed at a named
    // peer never rebinds: a playtest's DataModel is transient.
    if (options.chat && !options.peer) this.bindChat(options.chat, session);

    const command: StudioCommand = {
      id: `c_${randomUUID().slice(0, 8)}`,
      op,
      params,
      timeoutMs: options.timeoutMs,
    };

    const deferred = defer<unknown>();

    const timer = setTimeout(() => {
      endpoint.pending.delete(command.id);
      deferred.reject(
        new LuuCodeError("STUDIO_TIMEOUT", `Studio did not answer ${op} within ${options.timeoutMs}ms`, {
          details: { op, timeoutMs: options.timeoutMs },
          hint: "Studio may be busy compiling or mid-playtest. Check the connection and try again.",
        }),
      );
    }, options.timeoutMs);
    timer.unref?.();

    endpoint.pending.set(command.id, { op, deferred, timer });
    endpoint.queue.push(command);
    this.release(endpoint);

    return deferred.promise;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new LuuCodeError("SESSION_UNKNOWN", "That Studio connection is no longer registered.", {
        hint: "The playtest it belonged to has probably ended. Check run.state.",
      });
    }
    return session;
  }

  private requireEndpoint(session: SessionRecord, endpointId: string): EndpointRecord {
    const endpoint = session.endpoints.get(endpointId);
    if (!endpoint) {
      throw new LuuCodeError("STUDIO_NOT_CONNECTED", "That Studio connection went away before the command could be sent.", {
        hint: "A playtest transition drops connections. Check run.state and try again.",
      });
    }
    return endpoint;
  }

  /**
   * Every live plugin connection for the game the caller is working in, own
   * session first. Scoped by install id: a playtest's DataModel handshakes as a
   * session of its own but is the same game in the same Studio.
   */
  peers(target: SessionTarget = {}): PeerRef[] {
    const session = this.resolveSession(target);
    const siblings = [...this.sessions.values()].filter(
      (other) => other.id !== session.id && other.installId === session.installId && other.endpoints.size > 0,
    );

    const refs: PeerRef[] = [];
    for (const record of [session, ...siblings]) {
      for (const endpoint of record.endpoints.values()) {
        refs.push({
          sessionId: record.id,
          endpointId: endpoint.id,
          realm: endpoint.realm,
          run: endpoint.run,
          connectedAt: endpoint.connectedAt,
          capabilities: endpoint.capabilities,
        });
      }
    }

    return refs;
  }

  /** The first live connection matching `want`, or null when none does. */
  findPeer(target: SessionTarget, want: (peer: PeerRef) => boolean): PeerRef | null {
    return this.peers(target).find(want) ?? null;
  }

  private resolveSession(target: SessionTarget = {}): SessionRecord {
    if (target.sessionId) {
      const found = this.sessions.get(target.sessionId);
      if (!found) {
        throw new LuuCodeError("SESSION_UNKNOWN", `No Studio session with id ${target.sessionId} is connected.`);
      }
      return found;
    }

    const bound = target.chat ? this.chats.get(target.chat) : undefined;
    if (bound) return this.resolveBinding(target.chat!, bound);

    return this.defaultSession();
  }

  /**
   * Follows a chat to the window it has been working in. It must never answer
   * with a different game: a chat mid-task holds handles and a script it is
   * editing. Studio restarting is the one exception, since the window that
   * comes back is the same game under a new id.
   */
  private resolveBinding(chat: string, bound: ChatBinding): SessionRecord {
    const live = this.sessions.get(bound.sessionId);
    if (live && live.endpoints.size > 0) return live;

    const successor = this.findSuccessor(bound);
    if (successor) {
      log.info(`${chat}: ${bound.placeName} reconnected as ${successor.id}`);
      this.bindChat(chat, successor);
      return successor;
    }

    // Still registered but with nothing live behind it — a mid-playtest
    // transition, most likely.
    if (live) return live;

    throw new LuuCodeError("STUDIO_NOT_CONNECTED", `The Studio window this chat was working in (${bound.placeName}) is no longer connected.`, {
      details: { chat, place: bound.placeName, sessionId: bound.sessionId },
      hint: this.sessions.size > 0
        ? "Reopen that place in Studio, or point this chat at a connected one with session.select."
        : "Open the place in Roblox Studio; the plugin connects on its own.",
    });
  }

  /**
   * The same game, back under a new session id.
   *
   * Two windows on one place share an install id, so this can land on the other
   * one. They are the same game, which makes it a far smaller thing to be wrong
   * about than picking an unrelated place — and it only happens once the bound
   * window is gone.
   */
  private findSuccessor(bound: ChatBinding): SessionRecord | undefined {
    const live = [...this.sessions.values()].filter((session) => session.endpoints.size > 0);

    return (
      live.find((session) => session.installId === bound.installId) ??
      (bound.identity ? live.find((session) => session.place.identity === bound.identity) : undefined)
    );
  }

  private defaultSession(): SessionRecord {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (active && active.endpoints.size > 0) return active;

    // The selected session has no live connection: Studio was closed, the place
    // was swapped, or the process restarted. Falling through to a session that
    // can actually answer beats timing out against a dead one. This is only safe
    // because the caller named no chat, and so has no place it belongs to.
    const alive = [...this.sessions.values()]
      .filter((session) => session.endpoints.size > 0)
      .sort((left, right) => right.lastSeen - left.lastSeen)[0];

    if (alive) {
      this.activeSessionId = alive.id;
      return alive;
    }

    if (active) return active;

    throw new LuuCodeError("STUDIO_NOT_CONNECTED", "Roblox Studio is not connected to Luu Code.", {
      hint: "Open the place in Roblox Studio; the plugin connects on its own.",
    });
  }

  private bindChat(chat: string, session: SessionRecord): void {
    this.chats.set(chat, {
      sessionId: session.id,
      installId: session.installId,
      identity: session.place.identity ?? null,
      placeName: session.place.name,
    });
  }

  /**
   * The error routing would fail with, or null if it would succeed. Capability
   * checks run first, and "this capability is unavailable" is the wrong story
   * when the chat's window has closed.
   */
  targetError(target: SessionTarget = {}): LuuCodeError | null {
    try {
      this.resolveSession(target);
      return null;
    } catch (error) {
      return LuuCodeError.from(error);
    }
  }

  /**
   * Which connection serves this command.
   *
   * `selectEndpoint` prefers a running peer, which is right nearly always. The
   * exception is a capability that peer does not have: the playtest bridge is a
   * game script, so it cannot compile Luau, and routing `runtime.exec` there
   * because it happens to be running would refuse work the edit peer could do.
   * A named realm still wins — asking for a realm is asking for that DataModel.
   */
  private resolveEndpoint(session: SessionRecord, realm?: StudioRealm, capability?: CapabilityId | null): EndpointRecord {
    const publicSession = this.toPublicSession(session);
    let chosen = selectEndpoint(publicSession, realm);

    if (!realm && capability && chosen && !session.endpoints.get(chosen.id)?.capabilities.has(capability)) {
      const able = publicSession.endpoints.find((endpoint) => session.endpoints.get(endpoint.id)?.capabilities.has(capability));
      if (able) chosen = able;
    }

    if (!chosen) {
      throw new LuuCodeError(
        realm ? "RUNTIME_CONTEXT_UNAVAILABLE" : "STUDIO_NOT_CONNECTED",
        realm
          ? `Studio has no ${realm} connection right now.`
          : "The Studio session has no live connection.",
        {
          details: { realm, available: publicSession.endpoints.map((endpoint) => endpoint.realm) },
          hint: realm === "client" ? 'Start the playtest with mode "play" so a client exists to observe.' : undefined,
        },
      );
    }

    const record = session.endpoints.get(chosen.id);
    if (!record) {
      throw new LuuCodeError("STUDIO_NOT_CONNECTED", "The Studio connection disappeared while routing the command.");
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * The session a peer that is already running belongs to. A playtest's
   * DataModel generates its own window id, so by window alone it looks like a
   * second Studio window and the chat waiting on it never sees it.
   *
   * Matched on the pending start — the edit peer parked in
   * ExecutePlayModeAsync asked to play — and on the install id for a playtest
   * started by hand.
   */
  private sessionForRuntimePeer(request: StudioHelloRequest): string | null {
    if (request.run?.running !== true) return null;

    const candidates = [...this.sessions.values()].filter((session) => session.installId === request.installId);
    if (candidates.length === 0) return null;

    const asked = candidates.find((session) =>
      [...session.endpoints.values()].some((endpoint) => endpoint.run.pendingStart === true),
    );

    if (asked) return asked.id;

    // Only where there is no ambiguity: two windows on one place share an
    // install id, and the wrong one leaves a chat watching another's playtest.
    return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
  }

  private upsertSession(
    sessionId: string,
    request: Pick<StudioHelloRequest, "installId" | "place" | "studioVersion" | "pluginVersion">,
    windowId: string,
    token: string,
  ): SessionRecord {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      // Refreshed along with the place: a window with a different place open is
      // a different game, and chats must not follow the session into it.
      existing.installId = request.installId;
      existing.place = request.place;
      existing.studioVersion = request.studioVersion;
      existing.pluginVersion = request.pluginVersion;
      existing.token = token;
      existing.lastSeen = Date.now();
      this.byWindow.set(windowId, sessionId);
      return existing;
    }

    const record: SessionRecord = {
      id: sessionId,
      installId: request.installId,
      windowId,
      token,
      place: request.place,
      studioVersion: request.studioVersion,
      pluginVersion: request.pluginVersion,
      endpoints: new Map(),
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    };

    this.sessions.set(sessionId, record);
    this.byWindow.set(windowId, sessionId);
    this.activeSessionId ??= sessionId;
    return record;
  }

  private addEndpoint(session: SessionRecord, run: RunState, capabilities: CapabilityId[]): EndpointRecord {
    // Studio replaces the plugin's DataModel on every edit/run transition, so a
    // stale connection for the same realm is dead. Scoped to one session: two
    // Studio windows are both in the edit realm and neither replaced the other.
    // An edit peer clears the running ones too: a window reporting edit is not
    // playing, so they are left over from a finished playtest. A live one
    // re-handshakes on its next sync; a dead one cannot.
    const replaced = (existing: EndpointRecord): boolean =>
      existing.realm === run.realm || (run.realm === "edit" && existing.realm !== "edit");

    for (const [id, existing] of session.endpoints) {
      if (replaced(existing)) {
        this.failEndpoint(existing, new LuuCodeError("STUDIO_NOT_CONNECTED", "Studio replaced this connection."));
        session.endpoints.delete(id);
      }
    }

    const endpoint: EndpointRecord = {
      id: `e_${randomUUID().slice(0, 8)}`,
      sessionId: session.id,
      realm: run.realm,
      run,
      lastSeen: Date.now(),
      connectedAt: Date.now(),
      capabilities: new Set(capabilities),
      queue: [],
      pending: new Map(),
      park: null,
      parkTimer: null,
    };

    session.endpoints.set(endpoint.id, endpoint);

    // A newly connected Studio window takes over when the selected one has
    // nothing live behind it, so commands do not queue against a dead session.
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!active || active.endpoints.size === 0) {
      this.activeSessionId = session.id;
    }

    return endpoint;
  }

  private failEndpoint(endpoint: EndpointRecord, error: LuuCodeError): void {
    for (const pending of endpoint.pending.values()) {
      clearTimeout(pending.timer);
      pending.deferred.reject(error);
    }
    endpoint.pending.clear();
    endpoint.queue = [];

    if (endpoint.parkTimer) clearTimeout(endpoint.parkTimer);
    if (endpoint.park) endpoint.park.resolve({ commands: [], config: defaultRuntimeConfig() });
    endpoint.park = null;
    endpoint.parkTimer = null;
  }

  /**
   * A poll's socket closed with nothing written to it. Roblox drops the
   * connection when the DataModel that opened it is destroyed, and that is the
   * only notice a finished playtest gives — the peer is gone now rather than in
   * one staleness window's time, and `sweep` will not touch a parked endpoint.
   */
  abandon(sessionId: string, endpointId: string, token: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || !safeEquals(session.token, token ?? "")) return;

    const endpoint = session.endpoints.get(endpointId);
    // Only a poll still waiting. A request that was answered closes its socket
    // too, and re-handshaking is not abandonment.
    if (!endpoint || !endpoint.park) return;

    log.info(`Studio closed a parked connection (${endpoint.realm}); dropping it`);
    this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "Studio closed this connection."));
    session.endpoints.delete(endpointId);

    this.announce(session);
  }

  /**
   * Losing a peer changes what the session reports without changing what any
   * surviving peer says, so nothing else pushes it. The finished playtest's
   * client goes this way, leaving the app on "Playtest · client" until
   * something unrelated moved the status along.
   */
  private announce(session: SessionRecord): void {
    const state = this.toPublicSession(session).run;
    this.hooks.onRunState(session.id, state);
    this.bus.emit({ type: "run", sessionId: session.id, state });
    this.emitStatus();
  }

  private sweep(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      let dropped = false;

      for (const [endpointId, endpoint] of session.endpoints) {
        // A parked endpoint is holding an open request, so a stale timestamp
        // there means nothing. Without this the edit peer is dropped while
        // Studio has it suspended for a playtest.
        if (endpoint.park) continue;
        if (now - endpoint.lastSeen < SESSION_STALE_MS) continue;

        log.info(`Studio connection went quiet (${endpoint.realm}); dropping it`);
        this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "Studio stopped responding."));
        session.endpoints.delete(endpointId);
        dropped = true;
      }

      if (session.endpoints.size === 0 && now - session.lastSeen > SESSION_STALE_MS) {
        this.forget(session);
        this.bus.emit({ type: "session.disconnected", sessionId, reason: "Studio stopped responding" });
        this.emitStatus();
        continue;
      }

      if (dropped) this.announce(session);
    }
  }

  private runtimeConfig(session: SessionRecord): StudioRuntimeConfig {
    return {
      syncHoldMs: SYNC_HOLD_MS,
      outputBatchSize: 200,
      captureOutput: true,
    };
  }

  /**
   * Drops a session and everything keyed on it, leaving chats bound to it in
   * place: the window may be coming back, and findSuccessor reunites them.
   */
  private forget(session: SessionRecord): void {
    this.sessions.delete(session.id);
    this.byWindow.delete(session.windowId);

    if (this.activeSessionId === session.id) {
      this.activeSessionId = [...this.sessions.keys()][0] ?? null;
    }
  }

  capabilitiesFor(target: SessionTarget = {}): Set<CapabilityId> {
    let session: SessionRecord | undefined;
    try {
      session = this.resolveSession(target);
    } catch {
      return new Set();
    }

    const merged = new Set<CapabilityId>();
    for (const endpoint of session.endpoints.values()) {
      for (const capability of endpoint.capabilities) merged.add(capability);
    }
    return merged;
  }

  /** What the plugin in the targeted window calls itself. Null when none is connected. */
  pluginVersionFor(target: SessionTarget = {}): string | null {
    try {
      return this.resolveSession(target).pluginVersion;
    } catch {
      return null;
    }
  }

  runStateFor(target: SessionTarget = {}): RunState | null {
    let session: SessionRecord | undefined;
    try {
      session = this.resolveSession(target);
    } catch {
      return null;
    }

    const endpoint = selectEndpoint(this.toPublicSession(session));
    return endpoint?.run ?? null;
  }

  /** Which session's output and history a caller reads, named or not. */
  sessionKeyFor(target: SessionTarget = {}): string {
    try {
      return this.resolveSession(target).id;
    } catch {
      return this.activeSessionId ?? "default";
    }
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  /**
   * Points a chat at a Studio window, and moves the default along with it, so
   * the next new chat starts there too. Chats already bound elsewhere keep
   * working where they are.
   */
  selectSession(sessionId: string, chat?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new LuuCodeError("SESSION_UNKNOWN", `No Studio session with id ${sessionId} is connected.`);
    }

    if (chat) this.bindChat(chat, session);
    this.activeSessionId = sessionId;
    this.emitStatus();
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const endpoint of session.endpoints.values()) {
      this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "Disconnected by the user."));
    }

    this.forget(session);

    // Chats bound here keep their binding and say so if asked to do anything.
    // Disconnecting a window is not an instruction to redirect its work.

    this.bus.emit({ type: "session.disconnected", sessionId, reason: "Disconnected by the user" });
    this.emitStatus();
  }

  private toPublicSession(session: SessionRecord): StudioSession {
    const endpoints: StudioEndpoint[] = [...session.endpoints.values()]
      .map((endpoint) => ({
        id: endpoint.id,
        realm: endpoint.realm,
        run: endpoint.run,
        lastSeen: endpoint.lastSeen,
        polling: endpoint.park !== null,
      }))
      .sort((left, right) => right.lastSeen - left.lastSeen);

    // Only a connection that is still answering gets to say what mode the
    // session is in. A finished playtest's endpoints linger until they age out,
    // still claiming realm "client" and `running: true`, and `selectEndpoint`
    // prefers a running peer.
    const live = endpoints.filter((endpoint) => Date.now() - endpoint.lastSeen <= ENDPOINT_LIVE_MS);
    const primary = selectEndpoint({ ...emptyPublicSession(session), endpoints: live });

    return {
      id: session.id,
      installId: session.installId,
      windowId: session.windowId,
      place: session.place,
      studioVersion: session.studioVersion,
      pluginVersion: session.pluginVersion,
      status: endpoints.length > 0 ? "connected" : "stale",
      endpoints,
      run: sessionRunState(primary, live),
      lastSeen: session.lastSeen,
      active: this.activeSessionId === session.id,
    };
  }

  status(): SessionStatus {
    const chats: Record<string, string> = {};
    for (const [chat, bound] of this.chats) chats[chat] = bound.sessionId;

    return {
      serverVersion: this.serverVersion,
      sessions: [...this.sessions.values()].map((session) => this.toPublicSession(session)),
      activeSessionId: this.activeSessionId,
      chats,
    };
  }

  emitStatus(): void {
    this.bus.emit({ type: "status", status: this.status() });
  }
}

/**
 * What the window is doing, as opposed to what one connection is doing.
 *
 * Studio does not load the plugin into the DataModel a playtest creates, so on
 * a Play the only connection left is the edit one and it reports edit for the
 * whole session. `testActive` is its sight of the playtest beside it, and
 * without this a window with a game plainly running reads as idle.
 */
function sessionRunState(primary: StudioEndpoint | null, live: StudioEndpoint[]): RunState {
  const run = primary?.run ?? defaultRunState();
  if (run.running) return { ...run, observable: true };
  if (!live.some((endpoint) => endpoint.run.testActive === true)) return run;

  return { ...run, running: true, edit: false, realm: "unknown", ready: false, testActive: true, observable: false };
}

/**
 * Falls back to the install id for plugins built before windowId existed, which
 * then get one session per machine rather than failing to connect.
 */
function windowIdOf(request: StudioHelloRequest): string {
  return request.windowId ?? request.installId;
}

/** Every field a plugin can change about a place it has already identified. */
function samePlace(left: PlaceInfo, right: PlaceInfo): boolean {
  return (
    left.name === right.name &&
    left.placeId === right.placeId &&
    left.gameId === right.gameId &&
    left.unsaved === right.unsaved &&
    (left.nameSource ?? null) === (right.nameSource ?? null) &&
    (left.creatorId ?? null) === (right.creatorId ?? null) &&
    (left.creatorType ?? null) === (right.creatorType ?? null) &&
    (left.placeVersion ?? null) === (right.placeVersion ?? null)
  );
}

function emptyPublicSession(session: SessionRecord): StudioSession {
  return {
    id: session.id,
    installId: session.installId,
    windowId: session.windowId,
    place: session.place,
    studioVersion: session.studioVersion,
    pluginVersion: session.pluginVersion,
    status: "connected",
    endpoints: [],
    run: defaultRunState(),
    lastSeen: session.lastSeen,
    active: false,
  };
}

export function defaultRunState(): RunState {
  return { running: false, edit: true, mode: null, realm: "edit", epoch: 0, ready: false };
}

function defaultRuntimeConfig(): StudioRuntimeConfig {
  return { syncHoldMs: SYNC_HOLD_MS, outputBatchSize: 200, captureOutput: true };
}
