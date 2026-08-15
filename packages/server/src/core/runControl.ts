/**
 * Playtest orchestration, owned by the server. A transition destroys the
 * DataModel the request arrived in, so the server watches the run state
 * instead; and the two halves live in different peers — only the edit DataModel
 * can call `ExecutePlayModeAsync`, only a running one can call `EndTest`.
 * `findPeer` decides where each request goes.
 *
 * Nothing here touches the desktop.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import type { PlaytestMode, RunState } from "@luumen/code-protocol";
import type { PeerRef, SessionRegistry, SessionTarget } from "./sessions.js";
import { defaultRunState } from "./sessions.js";
import { sleep } from "../util/defer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("run");

const POLL_INTERVAL_MS = 150;
/**
 * How long to give a transition request itself. The handler returns as soon as
 * it has issued the call, so this covers the round trip, not the transition.
 */
const TRIGGER_TIMEOUT_MS = 8_000;
/** Studio needs a moment to finish tearing a session down before it takes another. */
const TEARDOWN_SETTLE_MS = 600;

export interface RunStartParams {
  mode: PlaytestMode;
  waitReady: boolean;
  timeoutMs: number;
  /**
   * Whether the plugin may put a bridge in the place for this playtest to carry
   * into its DataModel. Off means the playtest runs unobserved. Set from the
   * playtest permission, and nothing is installed while that is off.
   */
  bridge: boolean;
}

/** What the plugin says about the bridge it was asked to install. */
export interface BridgeReport {
  installed: boolean;
  reason?: string;
}

export interface RunStartResult extends RunState {
  ready: boolean;
  bridge?: BridgeReport;
}

export interface MultiplayerParams {
  action: "start" | "status" | "add_players" | "leave_client" | "end";
  players?: number;
  client: number;
  testArgs?: unknown;
  value?: unknown;
  timeoutMs: number;
}

const isEdit = (peer: PeerRef) => !peer.run.running;
const isRunning = (peer: PeerRef) => peer.run.running;
const isRunningServer = (peer: PeerRef) => peer.run.running && (peer.realm === "server" || peer.realm === "client");
/** Asked Studio to play and has not been told how it went. See RunState.pendingStart. */
const isStarting = (peer: PeerRef) => peer.run.pendingStart === true;
/** Can see a playtest, from inside it or from the edit DataModel beside it. */
const seesPlaytest = (peer: PeerRef) => peer.run.running || peer.run.testActive === true;

export class RunControl {
  constructor(private readonly sessions: SessionRegistry) {}

  /**
   * What this Studio window is doing, from whichever peer can say.
   *
   * A peer inside the session knows most, and is asked first. Failing that the
   * edit peer's `testActive` still settles whether a playtest exists: Studio
   * does not load the plugin into the DataModel a playtest creates, so on a
   * Play there is no peer inside one to ask. Reporting edit through a live
   * playtest is what made `run.start` look like it had failed.
   */
  state(target: SessionTarget): RunState {
    const running = this.sessions.findPeer(target, isRunning);
    if (running) return { ...running.run, observable: true };

    const base = this.sessions.runStateFor(target) ?? defaultRunState();

    if (!this.sessions.findPeer(target, seesPlaytest)) return { ...base, observable: false };

    return { ...base, running: true, edit: false, realm: "unknown", ready: false, testActive: true, observable: false };
  }

  private async waitFor(target: SessionTarget, predicate: (state: RunState) => boolean, timeoutMs: number): Promise<RunState> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const current = this.state(target);
      if (predicate(current)) return current;
      if (Date.now() >= deadline) return current;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Losing the connection mid-flight is success: the DataModel that handled it
   * has been replaced, which is what was asked for. Only a refusal Studio
   * actually voiced comes back.
   */
  private async trigger(
    op: "run.start" | "run.stop" | "run.multiplayer",
    params: Record<string, unknown>,
    peer: PeerRef,
    target: SessionTarget,
  ): Promise<{ error: LuuCodeError | null; data: unknown }> {
    try {
      const data = await this.sessions.send(op, params, { timeoutMs: TRIGGER_TIMEOUT_MS, peer, ...target });
      return { error: null, data };
    } catch (error) {
      const failure = LuuCodeError.from(error);

      if (failure.code === "STUDIO_TIMEOUT" || failure.code === "STUDIO_NOT_CONNECTED" || failure.code === "SESSION_UNKNOWN") {
        log.debug(`${op} lost its connection while Studio changed mode; watching the run state instead`);
        return { error: null, data: undefined };
      }

      return { error: failure, data: undefined };
    }
  }

  private requirePeer(target: SessionTarget, want: (peer: PeerRef) => boolean, missing: LuuCodeError): PeerRef {
    const peer = this.sessions.findPeer(target, want);
    if (!peer) throw missing;
    return peer;
  }

  async start(params: RunStartParams, target: SessionTarget = {}): Promise<RunStartResult> {
    const initial = this.state(target);

    if (initial.running) {
      throw new LuuCodeError("PLAYTEST_ALREADY_RUNNING", "A playtest is already running.", {
        details: { state: initial },
        hint: "Use run.restart to start a fresh session, or run.stop first.",
      });
    }

    const peer = this.requirePeer(
      target,
      isEdit,
      new LuuCodeError("STUDIO_NOT_CONNECTED", "No Studio window in edit mode is connected, so there is nothing to start a playtest from.", {
        hint: "A playtest can only be started from the edit DataModel. If one is already running, stop it first.",
      }),
    );

    // One budget for the whole transition, spent across waiting for the
    // playtest, for its bridge to connect, and for a character.
    const deadline = Date.now() + params.timeoutMs;
    const remaining = () => Math.max(deadline - Date.now(), 0);

    const issued = await this.trigger("run.start", { mode: params.mode, bridge: params.bridge }, peer, target);
    if (issued.error) throw issued.error;

    const bridge = (issued.data as { bridge?: BridgeReport } | undefined)?.bridge;
    const state = await this.waitFor(target, (current) => current.running, remaining());

    if (!state.running) {
      /**
       * Say what was observed, not what was assumed. "The playtest did not
       * start" is a claim about Studio; what is known is that Studio accepted
       * the request and nothing reported a playtest. A pending start narrows it
       * further: retrying cannot help.
       */
      const starting = this.sessions.findPeer(target, isStarting) !== null;

      throw new LuuCodeError(
        "STUDIO_TIMEOUT",
        starting
          ? `Studio accepted the request to play and has not returned, and no connected DataModel reports a playtest within ${params.timeoutMs}ms.`
          : `No Studio DataModel reported a running playtest within ${params.timeoutMs}ms.`,
        {
          details: {
            state,
            mode: params.mode,
            startPending: starting,
            peers: this.sessions.peers(target).map((peer) => ({
              realm: peer.realm,
              running: peer.run.running,
              testActive: peer.run.testActive ?? null,
              players: peer.run.playerCount ?? null,
              pendingStart: peer.run.pendingStart ?? null,
            })),
          },
          hint: "Look at Studio. If the place is not playing, it may still be loading — try again. If it is playing, this Studio build does not report playtests to the plugin and the plugin is probably out of date.",
        },
      );
    }

    /**
     * A bridge went into the place, so a peer from inside the playtest is on
     * its way — it has to boot the DataModel and handshake first, which lands
     * seconds after the transition does. Answering before then would report
     * every bridged playtest as unobservable.
     */
    const observed = bridge?.installed ? await this.waitFor(target, (current) => current.observable !== false, remaining()) : state;

    /**
     * Nothing inside the playtest. Either no bridge was asked for, or one could
     * not be installed: Studio does not load the plugin into the DataModel a
     * playtest creates, so without a bridge there is nothing in there to ask.
     * That is an outcome, not a failure — but it is never `ready`, since
     * nothing here can watch for a character, and saying so is the whole point.
     */
    if (observed.observable === false) {
      return { ...observed, mode: params.mode, ready: false, observable: false, ...(bridge ? { bridge } : {}) };
    }

    if (!params.waitReady) return { ...observed, ready: observed.ready, ...(bridge ? { bridge } : {}) };

    const ready = await this.waitFor(target, (current) => current.ready, remaining());
    return { ...ready, ready: ready.ready, ...(bridge ? { bridge } : {}) };
  }

  async stop(params: { timeoutMs: number }, target: SessionTarget = {}): Promise<RunState> {
    const initial = this.state(target);
    const starting = this.sessions.findPeer(target, isStarting);

    if (!initial.running && !starting) return initial;

    /**
     * Only a peer inside the session can end it. `EndTest` is refused anywhere
     * but the server DataModel of a running play session, and Studio does not
     * load the plugin into one, so the edit peer parked in
     * `ExecutePlayModeAsync` is no fallback.
     */
    const peer =
      this.sessions.findPeer(target, isRunning) ??
      (() => {
        throw new LuuCodeError(
          "RUNTIME_CONTEXT_UNAVAILABLE",
          "A playtest is running and Luu Code has no connection inside it, so there is nothing here that can end it. Studio does not load the plugin into the DataModel a playtest creates.",
          {
            details: { state: initial, startPending: starting !== null },
            hint: "Press Stop in Studio.",
          },
        );
      })();

    const refusal = await this.trigger("run.stop", {}, peer, target);
    if (refusal.error) throw refusal.error;

    // A playtest nobody reported running is over when the peer that started it
    // stops waiting on it.
    const state = await this.waitFor(
      target,
      (current) => !current.running && this.sessions.findPeer(target, isStarting) === null,
      params.timeoutMs,
    );

    if (state.running || this.sessions.findPeer(target, isStarting) !== null) {
      throw new LuuCodeError("STUDIO_TIMEOUT", `The playtest did not stop within ${params.timeoutMs}ms.`, {
        details: { state },
        hint: "Stop it in Studio, then continue.",
      });
    }

    return state;
  }

  async restart(params: { mode?: PlaytestMode; timeoutMs: number; bridge: boolean }, target: SessionTarget = {}): Promise<RunStartResult> {
    const before = this.state(target);
    const mode = params.mode ?? before.mode ?? "play";

    if (before.running) {
      await this.stop({ timeoutMs: params.timeoutMs }, target);
      await sleep(TEARDOWN_SETTLE_MS);
    }

    return this.start({ mode, waitReady: true, timeoutMs: params.timeoutMs, bridge: params.bridge }, target);
  }

  /** Each action goes to the peer that owns it: start to edit, the rest to the runtime. */
  async multiplayer(params: MultiplayerParams, target: SessionTarget = {}): Promise<unknown> {
    const payload: Record<string, unknown> = { action: params.action, timeoutMs: params.timeoutMs };
    if (params.players !== undefined) payload.players = params.players;
    if (params.testArgs !== undefined) payload.testArgs = params.testArgs;
    if (params.value !== undefined) payload.value = params.value;

    switch (params.action) {
      case "start": {
        const peer = this.requirePeer(
          target,
          isEdit,
          new LuuCodeError("PLAYTEST_ALREADY_RUNNING", "A multiplayer test has to be started from a Studio window in edit mode.", {
            hint: "Stop the running session first with run.stop.",
          }),
        );

        const refusal = await this.trigger("run.multiplayer", payload, peer, target);
        if (refusal.error) throw refusal.error;

        // The clients take a while to appear, and a status that reports none of
        // them yet is not an answer the caller can act on.
        const state = await this.waitFor(target, (current) => current.running, params.timeoutMs);

        if (!state.running) {
          throw new LuuCodeError("STUDIO_TIMEOUT", `The multiplayer test did not start within ${params.timeoutMs}ms.`, {
            details: { state, players: params.players },
          });
        }

        return this.multiplayerStatus(target, params);
      }

      case "status":
        return this.multiplayerStatus(target, params);

      case "add_players":
      case "end": {
        const peer = this.requirePeer(
          target,
          isRunningServer,
          new LuuCodeError("PLAYTEST_NOT_RUNNING", `No running server DataModel is connected, so "${params.action}" has nowhere to go.`, {
            hint: 'Start a multiplayer test first with action "start".',
          }),
        );

        return this.sessions.send("run.multiplayer", payload, { timeoutMs: params.timeoutMs + 5_000, peer, ...target });
      }

      case "leave_client": {
        // Ordered by when each client connected, so "client 2" means the second
        // one that joined and keeps meaning that for the life of the session.
        // Picking whichever the endpoint map yielded second would rename them
        // between two calls that asked the same question.
        const clients = this.sessions
          .peers(target)
          .filter((peer) => peer.run.running && peer.realm === "client")
          .sort((left, right) => left.connectedAt - right.connectedAt);

        const chosen = clients[params.client - 1];

        if (!chosen) {
          throw new LuuCodeError("RUNTIME_CONTEXT_UNAVAILABLE", `There is no client ${params.client} in this session.`, {
            details: { connectedClients: clients.length },
            hint: clients.length === 0 ? 'Start a multiplayer test first with action "start".' : `Clients 1 to ${clients.length} are connected.`,
          });
        }

        // The client tears its own DataModel down, so losing the connection is
        // the expected outcome rather than a failure.
        const refusal = await this.trigger("run.multiplayer", payload, chosen, target);
        if (refusal.error) throw refusal.error;

        return this.multiplayerStatus(target, params);
      }
    }
  }

  /**
   * Neither peer has the whole picture: the phase lives where the yielding call
   * is parked, and only the running server can see who joined.
   */
  private async multiplayerStatus(target: SessionTarget, params: MultiplayerParams): Promise<unknown> {
    const payload = { action: "status", timeoutMs: params.timeoutMs };
    const edit = this.sessions.findPeer(target, isEdit);
    const server = this.sessions.findPeer(target, isRunningServer);

    if (!edit && !server) {
      throw new LuuCodeError("STUDIO_NOT_CONNECTED", "No Studio connection can answer for the multiplayer session.");
    }

    const base = edit
      ? ((await this.sessions.send("run.multiplayer", payload, { timeoutMs: TRIGGER_TIMEOUT_MS, peer: edit, ...target })) as Record<
          string,
          unknown
        >)
      : {};

    if (!server) return base;

    const live = (await this.sessions.send("run.multiplayer", payload, {
      timeoutMs: TRIGGER_TIMEOUT_MS,
      peer: server,
      ...target,
    })) as Record<string, unknown>;

    return { ...base, connected: live.connected ?? [], run: live.run ?? base.run };
  }
}
