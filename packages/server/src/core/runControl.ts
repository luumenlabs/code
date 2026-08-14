/**
 * Playtest orchestration. Spec section 13.
 *
 * The server owns this for two reasons. A transition destroys the DataModel the
 * request arrived in, so the connection that would report the outcome is gone
 * before it can — the server survives and watches the run state instead. And the
 * two halves live in different peers: only the edit DataModel can call
 * `ExecutePlayModeAsync`, only a running one can call `EndTest`. `findPeer`
 * decides where each request goes.
 *
 * Nothing here touches the desktop. It used to press F5 through the operating
 * system, taking over the user's window, because the in-Studio attempt went
 * through an API a plugin cannot call.
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
 * it has issued the call — it cannot wait for the outcome, because the call it
 * makes does not return until the playtest is over — so this only has to cover
 * the round trip, not the transition.
 */
const TRIGGER_TIMEOUT_MS = 8_000;
/** Studio needs a moment to finish tearing a session down before it takes another. */
const TEARDOWN_SETTLE_MS = 600;

export interface RunStartParams {
  mode: PlaytestMode;
  waitReady: boolean;
  timeoutMs: number;
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

export class RunControl {
  constructor(private readonly sessions: SessionRegistry) {}

  /** A running peer is the one that knows: the edit peer's DataModel never runs. */
  private state(target: SessionTarget): RunState {
    const running = this.sessions.findPeer(target, isRunning);
    if (running) return running.run;

    return this.sessions.runStateFor(target) ?? defaultRunState();
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
   * Losing the connection mid-flight is success, not failure: the DataModel that
   * handled it has been replaced, which is what was asked for. Only a refusal
   * Studio actually voiced comes back.
   */
  private async trigger(
    op: "run.start" | "run.stop" | "run.multiplayer",
    params: Record<string, unknown>,
    peer: PeerRef,
    target: SessionTarget,
  ): Promise<LuuCodeError | null> {
    try {
      await this.sessions.send(op, params, { timeoutMs: TRIGGER_TIMEOUT_MS, peer, ...target });
      return null;
    } catch (error) {
      const failure = LuuCodeError.from(error);

      if (failure.code === "STUDIO_TIMEOUT" || failure.code === "STUDIO_NOT_CONNECTED" || failure.code === "SESSION_UNKNOWN") {
        log.debug(`${op} lost its connection while Studio changed mode; watching the run state instead`);
        return null;
      }

      return failure;
    }
  }

  private requirePeer(target: SessionTarget, want: (peer: PeerRef) => boolean, missing: LuuCodeError): PeerRef {
    const peer = this.sessions.findPeer(target, want);
    if (!peer) throw missing;
    return peer;
  }

  async start(params: RunStartParams, target: SessionTarget = {}): Promise<RunState & { ready: boolean }> {
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

    const refusal = await this.trigger("run.start", { mode: params.mode }, peer, target);
    if (refusal) throw refusal;

    const state = await this.waitFor(target, (current) => current.running, params.timeoutMs);

    if (!state.running) {
      /**
       * Say what was actually observed, not what was assumed.
       *
       * "The playtest did not start" is a claim about Studio, and it has been
       * wrong: the game was playing on screen while every peer kept reporting
       * edit, so the agent read the timeout as a refusal and went looking for a
       * reason in the place. What this knows is narrower and more useful —
       * Studio accepted the request and no connected DataModel ever said it was
       * running — so that is what it says, with the peers it heard from.
       *
       * A pending start narrows it: Studio took the request and has not
       * returned, so retrying cannot help.
       */
      const starting = this.sessions.findPeer(target, isStarting) !== null;

      throw new LuuCodeError(
        "STUDIO_TIMEOUT",
        starting
          ? `Studio accepted the request to play and has not returned, but no connected DataModel reports running within ${params.timeoutMs}ms.`
          : `No Studio DataModel reported a running playtest within ${params.timeoutMs}ms.`,
        {
          details: {
            state,
            mode: params.mode,
            startPending: starting,
            peers: this.sessions.peers(target).map((peer) => ({
              realm: peer.realm,
              running: peer.run.running,
              players: peer.run.playerCount ?? null,
              pendingStart: peer.run.pendingStart ?? null,
            })),
          },
          hint: starting
            ? "The place is almost certainly playing on screen. Luu Code cannot observe it, so treat the playtest as unavailable rather than retrying: say so, and carry on with what can be checked without it. run.stop will still end it."
            : "Look at Studio. If the place is not playing, it may still be loading — try again. If it is playing, the playtest is up but Luu Code cannot see it, and the Studio plugin is probably out of date.",
        },
      );
    }

    if (!params.waitReady) return { ...state, ready: state.ready };

    const ready = await this.waitFor(target, (current) => current.ready, params.timeoutMs);
    return { ...ready, ready: ready.ready };
  }

  async stop(params: { timeoutMs: number }, target: SessionTarget = {}): Promise<RunState> {
    const initial = this.state(target);
    const starting = this.sessions.findPeer(target, isStarting);

    if (!initial.running && !starting) return initial;

    /**
     * Only a running peer can end a playtest.
     *
     * This used to fall back to the peer parked in `ExecutePlayModeAsync` on
     * the theory that whoever started the session could end it. Studio refuses:
     * `EndTest` may only be called from the server DataModel of a running play
     * session, and the edit DataModel is never that. So the fallback could not
     * work, and what it produced was an UNSUPPORTED_CAPABILITY about a Studio
     * API — which reads as a broken build rather than as what it is, a playtest
     * that never connected back. Say the true thing instead.
     */
    const peer =
      this.sessions.findPeer(target, isRunning) ??
      (() => {
        throw new LuuCodeError(
          "PLAYTEST_NOT_RUNNING",
          starting
            ? "Studio was asked to play and no DataModel from that playtest ever connected to Luu Code, so there is nothing here that can end it."
            : "The running playtest has no connection to Luu Code, so it cannot be stopped from here.",
          {
            details: { state: initial, startPending: starting !== null },
            hint: "Press Stop in Studio. The playtest's own DataModel never reached Luu Code, so the plugin probably did not load into it — reinstall it under Settings → Updates and restart Studio if this keeps happening.",
          },
        );
      })();

    const refusal = await this.trigger("run.stop", {}, peer, target);
    if (refusal) throw refusal;

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

  async restart(params: { mode?: PlaytestMode; timeoutMs: number }, target: SessionTarget = {}): Promise<RunState & { ready: boolean }> {
    const before = this.state(target);
    const mode = params.mode ?? before.mode ?? "play";

    if (before.running) {
      await this.stop({ timeoutMs: params.timeoutMs }, target);
      await sleep(TEARDOWN_SETTLE_MS);
    }

    return this.start({ mode, waitReady: true, timeoutMs: params.timeoutMs }, target);
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
        if (refusal) throw refusal;

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
        if (refusal) throw refusal;

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
