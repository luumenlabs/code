/**
 * Playtest orchestration. Spec section 13.
 *
 * Two things make this the server's job rather than the plugin's.
 *
 * The first is that a transition destroys the DataModel the request arrived in,
 * so the connection that would report the outcome is usually gone before it
 * can. The server survives, fires the request, watches the run state arriving on
 * whichever connection comes back, and only then answers the agent.
 *
 * The second is that the two halves of a playtest live in different DataModels.
 * `StudioTestService:ExecutePlayModeAsync` can only be called from the edit
 * peer, and it yields for the entire life of the session; `EndTest` exists only
 * in the running peer. Neither can do the other's job, so something that can see
 * every connection has to decide where each request goes. That is what
 * `SessionRegistry.findPeer` is for.
 *
 * Nothing here touches the desktop. This module used to press F5 through the
 * operating system when the in-Studio attempt failed — which was always,
 * because that attempt went through an API a plugin is not allowed to call.
 * Every start took over the user's window and typed into it. Studio has offered
 * a real API for this the whole time.
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

export class RunControl {
  constructor(private readonly sessions: SessionRegistry) {}

  /**
   * The run state as the most authoritative peer sees it.
   *
   * A running peer is the one that knows: the edit peer's own DataModel is not
   * running and never will be, so asking it whether a playtest is up gets a
   * confident no throughout.
   */
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
   * Sends a transition to the peer that can perform it.
   *
   * Losing the connection mid-flight is success here, not failure: it means the
   * DataModel the request was handled in has been replaced, which is exactly
   * what was asked for. A refusal Studio actually voiced is the only thing worth
   * reporting, and it is returned rather than thrown so the caller can decide
   * whether the run state contradicts it.
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
      throw new LuuCodeError("STUDIO_TIMEOUT", `The playtest did not start within ${params.timeoutMs}ms.`, {
        details: { state, mode: params.mode },
        hint: "Studio may still be loading the place. Check Studio, then try again.",
      });
    }

    if (!params.waitReady) return { ...state, ready: state.ready };

    const ready = await this.waitFor(target, (current) => current.ready, params.timeoutMs);
    return { ...ready, ready: ready.ready };
  }

  async stop(params: { timeoutMs: number }, target: SessionTarget = {}): Promise<RunState> {
    const initial = this.state(target);
    if (!initial.running) return initial;

    // EndTest only exists inside the session it is ending. Sending this to the
    // edit peer would reach a DataModel with no test to end, and it would say so
    // rather than doing anything.
    const peer = this.requirePeer(
      target,
      isRunning,
      new LuuCodeError("PLAYTEST_NOT_RUNNING", "The running playtest has no connection to Luu Code, so it cannot be stopped from here.", {
        details: { state: initial },
        hint: "Press Stop in Studio. If this keeps happening, the plugin may not have loaded into the playtest's DataModel.",
      }),
    );

    const refusal = await this.trigger("run.stop", {}, peer, target);
    if (refusal) throw refusal;

    const state = await this.waitFor(target, (current) => !current.running, params.timeoutMs);

    if (state.running) {
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

  /**
   * The multiplayer lifecycle, each action routed to the peer that owns it.
   *
   * `start` belongs to the edit peer, because that is the only one that can call
   * `ExecuteMultiplayerTestAsync`. `add_players` and `end` belong to the running
   * server. `leave_client` belongs to the client being removed. `status` is
   * answered by the edit peer, which holds the session's phase, unless the
   * session is up — in which case the running server can also say who joined.
   */
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
   * Phase from the edit peer, connected players from the running server.
   *
   * Neither one has the whole picture. The edit peer is the only place the
   * session's phase and its eventual return value exist, because the thread that
   * started the test is parked there; the running server is the only place that
   * can see who actually joined.
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
