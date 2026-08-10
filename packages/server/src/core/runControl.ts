/**
 * Playtest orchestration. Spec section 13.
 *
 * Starting or stopping a playtest tears down the DataModel the plugin lives in,
 * so the command that triggers it usually cannot report its own outcome: the
 * connection that would have answered no longer exists. The server owns the
 * waiting instead. It fires the request, watches the run state arriving on
 * whichever connection comes back, and only then answers the agent.
 *
 * That is also where the two ways of pressing Play are reconciled. Studio
 * exposes Run to plugins but not Play, so if the in-Studio attempt does not
 * take effect the desktop shortcut is used as a fallback.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import type { PlaytestMode, RunState } from "@luumen/code-protocol";
import type { SessionRegistry, SessionTarget } from "./sessions.js";
import { defaultRunState } from "./sessions.js";
import type { NativeInput } from "../native/input.js";
import { sleep } from "../util/defer.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("run");

/** How long to give the in-Studio attempt before trying the desktop shortcut. */
const IN_STUDIO_GRACE_MS = 6_000;
const POLL_INTERVAL_MS = 150;
const TRIGGER_TIMEOUT_MS = 4_000;

export interface RunStartParams {
  mode: PlaytestMode;
  waitReady: boolean;
  timeoutMs: number;
}

export class RunControl {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly nativeInput: NativeInput,
  ) {}

  private state(target: SessionTarget): RunState {
    return this.sessions.runStateFor(target) ?? defaultRunState();
  }

  private async waitFor(
    target: SessionTarget,
    predicate: (state: RunState) => boolean,
    timeoutMs: number,
  ): Promise<RunState> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const current = this.state(target);
      if (predicate(current)) return current;
      if (Date.now() >= deadline) return current;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Fires a command we do not expect to hear back from. A playtest transition
   * frequently kills the connection mid-flight, and that is success, not
   * failure, so only a capability refusal is meaningful here.
   */
  private async trigger(op: "run.start" | "run.stop", params: Record<string, unknown>, target: SessionTarget): Promise<LuuCodeError | null> {
    try {
      await this.sessions.send(op, params, { timeoutMs: TRIGGER_TIMEOUT_MS, ...target });
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

  async start(params: RunStartParams, target: SessionTarget = {}): Promise<RunState & { ready: boolean }> {
    const initial = this.state(target);

    if (initial.running) {
      throw new LuuCodeError("PLAYTEST_ALREADY_RUNNING", "A playtest is already running.", {
        details: { state: initial },
        hint: "Use run.restart to start a fresh session, or run.stop first.",
      });
    }

    const refusal = await this.trigger("run.start", { mode: params.mode }, target);

    if (refusal && refusal.code !== "UNSUPPORTED_CAPABILITY") {
      throw refusal;
    }

    let state = await this.waitFor(target, (current) => current.running, IN_STUDIO_GRACE_MS);

    if (!state.running && params.mode === "play") {
      if (!this.nativeInput.available) {
        throw new LuuCodeError("UNSUPPORTED_CAPABILITY", "Studio did not start Play mode and no desktop fallback is available.", {
          details: { platform: process.platform, studioRefusal: refusal?.toWire() ?? null },
          hint: 'Use mode "run" for a server-only playtest, or press Play in Studio yourself.',
        });
      }

      log.info("Studio did not enter Play mode; pressing Play through the desktop shortcut");
      await this.nativeInput.pressStudioShortcut("play");
      state = await this.waitFor(target, (current) => current.running, params.timeoutMs);
    }

    if (!state.running) {
      throw new LuuCodeError("STUDIO_TIMEOUT", `The playtest did not start within ${params.timeoutMs}ms.`, {
        details: { state },
        hint: "Studio may still be loading the place. Check Studio, then try again.",
      });
    }

    if (!params.waitReady) {
      return { ...state, ready: state.ready };
    }

    const ready = await this.waitFor(target, (current) => current.ready, params.timeoutMs);
    return { ...ready, ready: ready.ready };
  }

  async stop(target: SessionTarget = {}): Promise<RunState> {
    const initial = this.state(target);
    if (!initial.running) return initial;

    const refusal = await this.trigger("run.stop", {}, target);
    if (refusal && refusal.code !== "UNSUPPORTED_CAPABILITY") throw refusal;

    let state = await this.waitFor(target, (current) => !current.running, IN_STUDIO_GRACE_MS);

    if (state.running && this.nativeInput.available) {
      log.info("Studio did not leave the playtest; sending the stop shortcut");
      await this.nativeInput.pressStudioShortcut("stop");
      state = await this.waitFor(target, (current) => !current.running, IN_STUDIO_GRACE_MS);
    }

    if (state.running) {
      throw new LuuCodeError("STUDIO_TIMEOUT", "The playtest did not stop.", {
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
      await this.stop(target);
      // Studio needs a moment to finish tearing the session down before it will
      // accept a new one.
      await sleep(400);
    }

    return this.start({ mode, waitReady: true, timeoutMs: params.timeoutMs }, target);
  }
}
