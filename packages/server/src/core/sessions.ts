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
  token: string;
  place: StudioSession["place"];
  studioVersion: string;
  pluginVersion: string;
  endpoints: Map<string, EndpointRecord>;
  lastSeen: number;
  connectedAt: number;
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

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
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
    const paired = request.token ? this.settings.findPairedByToken(request.token) : undefined;

    // A stored token is the only silent path back in. Recognising an install id
    // alone would make that id equivalent to a credential, and it is readable
    // by any process that can read Studio's settings.
    if (paired && request.token && safeEquals(paired.token, request.token)) {
      const session = this.upsertSession(paired.sessionId, request, paired.token);
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

    const existing = [...this.pairings.values()].find((entry) => entry.request.installId === request.installId);
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

  pair(sessionId: string, installId: string): StudioPairResponse {
    const pending = this.pairings.get(sessionId);

    if (!pending || pending.request.installId !== installId) {
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
      token,
    );

    const endpoint = this.addEndpoint(session, pending.run, pending.capabilities);

    // The user just approved this window, which is the clearest statement of
    // which Studio session they mean. They can switch back with session.select.
    this.activeSessionId = session.id;

    this.settings.addPaired({
      sessionId,
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
  async send(op: Op, params: Record<string, unknown>, options: { sessionId?: string; realm?: StudioRealm; timeoutMs: number }): Promise<unknown> {
    const session = this.resolveSession(options.sessionId);
    const endpoint = this.resolveEndpoint(session, options.realm);

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

  private resolveSession(sessionId?: string): SessionRecord {
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (!found) {
        throw new LuuCodeError("SESSION_UNKNOWN", `No Studio session with id ${sessionId} is connected.`);
      }
      return found;
    }

    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (active && active.endpoints.size > 0) return active;

    // The selected session has no live connection: Studio was closed, the place
    // was swapped, or the process restarted. Falling through to a session that
    // can actually answer beats timing out against a dead one.
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
    token: string,
  ): SessionRecord {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.place = request.place;
      existing.studioVersion = request.studioVersion;
      existing.pluginVersion = request.pluginVersion;
      existing.token = token;
      existing.lastSeen = Date.now();
      return existing;
    }

    const record: SessionRecord = {
      id: sessionId,
      installId: request.installId,
      token,
      place: request.place,
      studioVersion: request.studioVersion,
      pluginVersion: request.pluginVersion,
      endpoints: new Map(),
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    };

    this.sessions.set(sessionId, record);
    this.activeSessionId ??= sessionId;
    return record;
  }

  private addEndpoint(session: SessionRecord, run: RunState, capabilities: CapabilityId[]): EndpointRecord {
    // Studio replaces the plugin's DataModel on every edit/run transition, so a
    // stale connection for the same realm is dead by definition.
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
        this.sessions.delete(sessionId);
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = [...this.sessions.keys()][0] ?? null;
        }
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

  capabilitiesFor(sessionId?: string): Set<CapabilityId> {
    let session: SessionRecord | undefined;
    try {
      session = this.resolveSession(sessionId);
    } catch {
      return new Set();
    }

    const merged = new Set<CapabilityId>();
    for (const endpoint of session.endpoints.values()) {
      for (const capability of endpoint.capabilities) merged.add(capability);
    }
    return merged;
  }

  runStateFor(sessionId?: string): RunState | null {
    let session: SessionRecord | undefined;
    try {
      session = this.resolveSession(sessionId);
    } catch {
      return null;
    }

    const endpoint = selectEndpoint(this.toPublicSession(session));
    return endpoint?.run ?? null;
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  selectSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new LuuCodeError("SESSION_UNKNOWN", `No Studio session with id ${sessionId} is connected.`);
    }
    this.activeSessionId = sessionId;
    this.emitStatus();
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const endpoint of session.endpoints.values()) {
      this.failEndpoint(endpoint, new LuuCodeError("STUDIO_NOT_CONNECTED", "Disconnected by the user."));
    }

    this.sessions.delete(sessionId);
    this.settings.removePaired(sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = [...this.sessions.keys()][0] ?? null;
    }

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
    return {
      serverVersion: this.serverVersion,
      sessions: [...this.sessions.values()].map((session) => this.toPublicSession(session)),
      activeSessionId: this.activeSessionId,
      pending: this.pendingPairings(),
    };
  }

  emitStatus(): void {
    this.bus.emit({ type: "status", status: this.status() });
  }
}

function emptyPublicSession(session: SessionRecord): StudioSession {
  return {
    id: session.id,
    installId: session.installId,
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
