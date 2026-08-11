/**
 * Studio session registry: pairing, connection lifecycle, and command routing.
 * Spec sections 8, 26, 29, and 30.
 */
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
  PairingRequest,
  PlaceInfo,
  RunState,
  SessionStatus,
  StudioCommand,
  StudioEndpoint,
  StudioHelloRequest,
  StudioHelloResponse,
  StudioPairResponse,
  StudioRealm,
  StudioRuntimeConfig,
  StudioSession,
  StudioSyncRequest,
  StudioSyncResponse,
} from "@luumen/code-protocol";
import { generatePairingCode, generateToken, safeEquals } from "./auth.js";
import { EventBus } from "./events.js";
import type { SettingsStore } from "../config/settings.js";
import { defer } from "../util/defer.js";
import type { Deferred } from "../util/defer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("sessions");

const PAIRING_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5_000;

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
 * Which Studio window a caller means.
 *
 * An explicit session id wins. Otherwise the chat decides, because chats run
 * concurrently and each one is working in a particular place. Only a caller
 * with neither — an external MCP client, say — falls back to the default.
 */
export interface SessionTarget {
  sessionId?: string;
  chat?: string;
}

/**
 * What a chat is working in.
 *
 * The session id alone would not survive Studio restarting: the window that
 * comes back is a new session, and the chat would be stranded against an id
 * that no longer exists. The install id and place identity are recorded so the
 * same game can be recognised when it returns.
 */
interface ChatBinding {
  sessionId: string;
  installId: string;
  identity: string | null;
  placeName: string;
}

interface PendingPairing {
  request: PairingRequest;
  approved: boolean | null;
  timer: NodeJS.Timeout;
  /**
   * Carried over from the handshake so the connection is fully described the
   * instant it is approved. Without this there is a window where every
   * capability check fails on a freshly paired session.
   */
  capabilities: CapabilityId[];
  run: RunState;
}

export interface SessionEvents {
  onOutput(sessionId: string, entries: Array<Record<string, unknown>>): void;
  onRunState(sessionId: string, state: RunState): void;
}

/**
 * One live plugin connection, named well enough to send a command straight to
 * it.
 *
 * Studio runs the plugin separately in the edit DataModel and in each one a
 * playtest creates, and only the edit peer can start a playtest while only a
 * running peer can end one. Which connection a request reaches is part of the
 * operation, not a routing preference.
 */
export interface PeerRef {
  sessionId: string;
  endpointId: string;
  realm: StudioRealm;
  run: RunState;
  /** First handshake, which is what gives "client 2" a stable meaning. */
  connectedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Window id to session id, so a re-handshake finds its own session. */
  private readonly byWindow = new Map<string, string>();
  private readonly chats = new Map<string, ChatBinding>();
  private readonly pairings = new Map<string, PendingPairing>();
  private activeSessionId: string | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: SettingsStore,
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
  // Handshake and pairing
  // -------------------------------------------------------------------------

  hello(request: StudioHelloRequest): StudioHelloResponse {
    const windowId = windowIdOf(request);
    const paired = request.token ? this.settings.findPairedByToken(request.token) : undefined;

    // A stored token is the only silent path back in. Recognising an install id
    // alone would make that id equivalent to a credential, and it is readable
    // by any process that can read Studio's settings.
    if (paired && request.token && safeEquals(paired.token, request.token) && paired.installId === request.installId) {
      // The credential belongs to the game; the session belongs to the window.
      // A second window on an already-approved place connects silently and
      // still gets a session of its own.
      const sessionId = this.byWindow.get(windowId) ?? `s_${randomUUID().slice(0, 8)}`;
      const session = this.upsertSession(sessionId, request, windowId, paired.token);
      const endpoint = this.addEndpoint(session, request.run, request.capabilities);

      this.settings.addPaired({
        ...paired,
        placeName: request.place.name,
        placeId: request.place.placeId,
      });

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

    // Matched on the window, not the game: two windows asking to connect are two
    // approvals, and collapsing them would show one code for both.
    const existing = [...this.pairings.values()].find((entry) => entry.request.windowId === windowId);
    if (existing && existing.approved === null) {
      // The plugin restarted while a request was already on screen; keep the
      // same code so the user is not asked to compare a new one.
      return {
        status: "pairing",
        sessionId: existing.request.sessionId,
        pairingCode: existing.request.code,
        expiresAt: existing.request.expiresAt,
      };
    }

    const sessionId = `s_${randomUUID().slice(0, 8)}`;
    const pairingRequest: PairingRequest = {
      sessionId,
      installId: request.installId,
      windowId,
      code: generatePairingCode(),
      place: request.place,
      studioVersion: request.studioVersion,
      pluginVersion: request.pluginVersion,
      requestedAt: Date.now(),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };

    const timer = setTimeout(() => this.pairings.delete(sessionId), PAIRING_TTL_MS);
    timer.unref?.();

    this.pairings.set(sessionId, {
      request: pairingRequest,
      approved: null,
      timer,
      capabilities: request.capabilities ?? [],
      run: request.run ?? defaultRunState(),
    });
    this.bus.emit({ type: "pairing.requested", request: pairingRequest });
    this.emitStatus();

    if (this.settings.get().autoApprovePairing) {
      log.info(`Auto-approving ${request.place.name} (autoApprovePairing is on)`);
      this.approvePairing(sessionId);
    } else {
      log.info(`Studio wants to connect: ${request.place.name}. Approval code ${pairingRequest.code}`);
    }

    return {
      status: "pairing",
      sessionId,
      pairingCode: pairingRequest.code,
      expiresAt: pairingRequest.expiresAt,
    };
  }

  pair(sessionId: string, installId: string, windowId?: string): StudioPairResponse {
    const pending = this.pairings.get(sessionId);
    const window = windowId ?? installId;

    if (!pending || pending.request.installId !== installId || pending.request.windowId !== window) {
      return {
        status: "rejected",
        error: new LuuCodeError("SESSION_UNKNOWN", "This pairing request expired. Reconnect from Studio to get a new code.").toWire(),
      };
    }

    if (pending.approved === null) return { status: "pending" };

    if (pending.approved === false) {
      this.clearPairing(sessionId);
      return {
        status: "rejected",
        error: new LuuCodeError("PERMISSION_DENIED", "The connection was declined in Luu Code.").toWire(),
      };
    }

    const token = generateToken();
    const session = this.upsertSession(
      sessionId,
      {
        installId,
        place: pending.request.place,
        studioVersion: pending.request.studioVersion,
        pluginVersion: pending.request.pluginVersion,
      },
      window,
      token,
    );

    const endpoint = this.addEndpoint(session, pending.run, pending.capabilities);

    // The user just approved this window, which is the clearest statement of
    // which Studio session they mean. It becomes the default for chats that
    // have not picked one; chats already bound elsewhere are left alone.
    this.activeSessionId = session.id;

    this.settings.addPaired({
      installId,
      token,
      placeName: pending.request.place.name,
      placeId: pending.request.place.placeId,
      pairedAt: Date.now(),
    });

    this.clearPairing(sessionId);
    this.bus.emit({ type: "pairing.resolved", sessionId, approved: true });
    this.bus.emit({ type: "session.connected", session: this.toPublicSession(session) });
    this.emitStatus();

    log.info(`Paired with ${pending.request.place.name}`);

    return { status: "connected", endpointId: endpoint.id, token, config: this.runtimeConfig(session) };
  }

  approvePairing(sessionId: string): boolean {
    const pending = this.pairings.get(sessionId);
    if (!pending || pending.approved !== null) return false;
    pending.approved = true;
    return true;
  }

  rejectPairing(sessionId: string): boolean {
    const pending = this.pairings.get(sessionId);
    if (!pending || pending.approved !== null) return false;
    pending.approved = false;
    this.bus.emit({ type: "pairing.resolved", sessionId, approved: false });
    this.emitStatus();
    return true;
  }

  pendingPairings(): PairingRequest[] {
    return [...this.pairings.values()].filter((entry) => entry.approved === null).map((entry) => entry.request);
  }

  private clearPairing(sessionId: string): void {
    const pending = this.pairings.get(sessionId);
    if (pending) clearTimeout(pending.timer);
    this.pairings.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async sync(request: StudioSyncRequest): Promise<StudioSyncResponse> {
    const session = this.sessions.get(request.sessionId);

    if (!session || !safeEquals(session.token, request.token ?? "")) {
      throw new LuuCodeError("UNAUTHORIZED", "This Studio session is not paired with the local server.");
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
   * The same game, described better.
   *
   * The plugin resolves the published place name after the handshake, so the
   * first thing this server is told about a place is often `game.Name` and the
   * real one arrives on a later sync. Only the description is allowed to move:
   * a payload naming a different identity is a different game, and a session
   * that quietly changed which place it stood for would relabel every chat
   * bound to it and every change filed against it.
   *
   * Compared field by field rather than by serialising: the plugin builds this
   * from a Lua table, whose key order is whatever the hash gave, so two
   * encodings of one unchanged place are not the same string — and a status
   * event on every poll is a re-render of the whole window twice a second.
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
    options: SessionTarget & { realm?: StudioRealm; peer?: PeerRef; timeoutMs: number },
  ): Promise<unknown> {
    const session = options.peer ? this.requireSession(options.peer.sessionId) : this.resolveSession(options);
    const endpoint = options.peer ? this.requireEndpoint(session, options.peer.endpointId) : this.resolveEndpoint(session, options.realm);

    // Bound here rather than at resolution, so a chat is pinned by the first
    // command it actually sends and not by a status or capability probe. A
    // command aimed at a named peer never rebinds: a playtest's DataModel is a
    // transient connection, and following a chat into one would strand it the
    // moment the playtest ended.
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
   * session first.
   *
   * Scoped by install id rather than session: a playtest's DataModel generates a
   * fresh window id and handshakes as a session of its own, but it is the same
   * game in the same Studio.
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
   * Follows a chat to the window it has been working in.
   *
   * The one thing this must never do is quietly answer with a different game.
   * A chat mid-task holds instance handles, a script it is editing, and an idea
   * of what is running; pointing it at whatever else happens to be open would
   * apply all of that to the wrong place, and nothing in the transcript would
   * say so. Studio restarting is the exception worth handling, because the
   * window that comes back is the same game under a new id.
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

    // Still registered but with nothing live behind it — mid-playtest
    // transition, most likely. The endpoint check reports that far better than
    // a guess about which window the user meant.
    if (live) return live;

    throw new LuuCodeError("STUDIO_NOT_CONNECTED", `The Studio window this chat was working in (${bound.placeName}) is no longer connected.`, {
      details: { chat, place: bound.placeName, sessionId: bound.sessionId },
      hint: this.sessions.size > 0
        ? "Reopen that place in Studio, or point this chat at a connected one with session.select."
        : "Open the place in Studio and approve the Luu Code connection panel.",
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
      hint: "Open the place in Studio and approve the Luu Code connection panel.",
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
   * The error routing would fail with, or null if it would succeed.
   *
   * Capability checks run before anything is sent, and "this capability is
   * unavailable" is the wrong story when the real problem is that the window
   * the chat belongs to has closed.
   */
  targetError(target: SessionTarget = {}): LuuCodeError | null {
    try {
      this.resolveSession(target);
      return null;
    } catch (error) {
      return LuuCodeError.from(error);
    }
  }

  private resolveEndpoint(session: SessionRecord, realm?: StudioRealm): EndpointRecord {
    const publicSession = this.toPublicSession(session);
    const chosen = selectEndpoint(publicSession, realm);

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

  private upsertSession(
    sessionId: string,
    request: Pick<StudioHelloRequest, "installId" | "place" | "studioVersion" | "pluginVersion">,
    windowId: string,
    token: string,
  ): SessionRecord {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      // The install id is refreshed along with the place: a window that has had
      // a different place opened in it is a different game, and leaving the old
      // id behind would have chats follow the session into it.
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
    // stale connection for the same realm is dead by definition. This is scoped
    // to one session for a reason: two Studio windows are both in the edit realm
    // and neither replaced the other.
    for (const [id, existing] of session.endpoints) {
      if (existing.realm === run.realm) {
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

  private sweep(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      for (const [endpointId, endpoint] of session.endpoints) {
        // A parked endpoint is holding an open request, so a stale timestamp
        // there means nothing.
        if (endpoint.park) continue;
        if (now - endpoint.lastSeen < SESSION_STALE_MS) continue;

        log.info(`Studio connection went quiet (${endpoint.realm}); dropping it`);
        this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "Studio stopped responding."));
        session.endpoints.delete(endpointId);
      }

      if (session.endpoints.size === 0 && now - session.lastSeen > SESSION_STALE_MS) {
        this.forget(session);
        this.bus.emit({ type: "session.disconnected", sessionId, reason: "Studio stopped responding" });
        this.emitStatus();
      }
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
   * Points a chat at a Studio window, and moves the default along with it.
   *
   * Moving the default too is what makes the picker behave the way it looks:
   * the user chose a window while looking at a chat, so that chat goes there,
   * and the next chat they open starts there rather than somewhere older. Chats
   * already bound elsewhere keep working where they are.
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

    // The approval covers the game, not this one window. Revoking it while
    // another window still has the place open would knock that one out too, and
    // it was never the one disconnected.
    const stillOpen = [...this.sessions.values()].some((other) => other.installId === session.installId);
    if (!stillOpen) this.settings.removePaired(session.installId);

    // Chats bound here keep their binding, and say so if asked to do anything.
    // Silently moving them onto whatever else is connected is the failure this
    // whole path exists to prevent — disconnecting a window is not an
    // instruction to redirect the work that was happening in it.

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

    const primary = selectEndpoint({ ...emptyPublicSession(session), endpoints });

    return {
      id: session.id,
      installId: session.installId,
      windowId: session.windowId,
      place: session.place,
      studioVersion: session.studioVersion,
      pluginVersion: session.pluginVersion,
      status: endpoints.length > 0 ? "connected" : "stale",
      endpoints,
      run: primary?.run ?? defaultRunState(),
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
      pending: this.pendingPairings(),
    };
  }

  emitStatus(): void {
    this.bus.emit({ type: "status", status: this.status() });
  }
}

/**
 * Falls back to the install id for plugins built before windowId existed. Those
 * behave exactly as they used to — one session per machine — instead of failing
 * to connect against a newer server.
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
