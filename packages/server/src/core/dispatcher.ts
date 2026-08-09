/**
 * The single path every Roblox operation takes.
 *
 * Validation, permissions, capability gating, routing, and the activity log all
 * live here so the harness and MCP get identical behaviour. An external agent
 * connected over MCP is not a second-class client; it runs through this exact
 * code. Spec sections 21 and 25.
 */
import { randomUUID } from "node:crypto";
import { COMMANDS, LuuCodeError, isOp } from "@luumen/code-protocol";
import type {
  ActivityEvent,
  CapabilityId,
  CapabilityReport,
  Op,
  RunState,
  ScreenshotResult,
  SessionStatus,
  StudioRealm,
} from "@luumen/code-protocol";
import { ZodError } from "zod";
import { categoryFor, detailFor, instancesFor, titleFor } from "./activity.js";
import { buildCapabilityReport } from "./capabilities.js";
import type { EventBus } from "./events.js";
import { nilTagsToNulls, nullsToNilTags } from "./normalize.js";
import type { OutputStore } from "./output.js";
import type { RunControl } from "./runControl.js";
import type { SessionRegistry } from "./sessions.js";
import type { SettingsStore } from "../config/settings.js";
import type { NativeInput } from "../native/input.js";
import type { ScreenshotProvider, ScreenshotRequest } from "../native/screenshot.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("dispatch");

const DEFAULT_TIMEOUT_MS = 15_000;
/** Operations that legitimately take longer than a normal round trip. */
const SLOW_OPS: Partial<Record<Op, number>> = {
  "dm.tree": 30_000,
  "dm.search": 30_000,
  "script.list": 30_000,
  "input.text": 60_000,
};

export interface ExecuteContext {
  origin: ActivityEvent["origin"];
  sessionId?: string;
  realm?: StudioRealm;
}

export interface DispatcherDeps {
  sessions: SessionRegistry;
  settings: SettingsStore;
  bus: EventBus;
  output: OutputStore;
  runControl: RunControl;
  nativeInput: NativeInput;
  getScreenshotProvider: () => ScreenshotProvider | null;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  capabilityReport(sessionId?: string): CapabilityReport {
    return buildCapabilityReport({
      studio: this.deps.sessions.capabilitiesFor(sessionId),
      studioConnected: this.deps.sessions.hasSessions(),
      run: this.deps.sessions.runStateFor(sessionId),
      nativeInputAvailable: this.deps.nativeInput.available,
      screenshotAvailable: this.deps.getScreenshotProvider() !== null,
      settings: this.deps.settings,
    });
  }

  async execute(op: string, rawParams: unknown, context: ExecuteContext): Promise<unknown> {
    if (!isOp(op)) {
      throw new LuuCodeError("INVALID_PARAMS", `Unknown operation "${op}".`, {
        hint: "Call session.capabilities to see what this build supports.",
      });
    }

    const spec = COMMANDS[op];
    const params = this.validate(op, rawParams);

    this.checkPermission(op);
    this.checkCapability(op, spec.capability, context.sessionId);

    const activity: ActivityEvent = {
      id: `a_${randomUUID().slice(0, 8)}`,
      op,
      origin: context.origin,
      title: titleFor(op, params),
      detail: null,
      category: categoryFor(op),
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      error: null,
      instances: [],
      image: null,
    };

    this.deps.bus.emit({ type: "activity", activity });

    try {
      const result = await this.route(op, params, context);
      const normalized = nilTagsToNulls(result);

      this.deps.bus.emit({
        type: "activity",
        activity: {
          ...activity,
          finishedAt: Date.now(),
          status: "ok",
          detail: detailFor(op, normalized),
          instances: instancesFor(normalized),
          image: op === "view.screenshot" ? imageFrom(normalized) : null,
        },
      });

      return normalized;
    } catch (error) {
      const failure = LuuCodeError.from(error);

      this.deps.bus.emit({
        type: "activity",
        activity: { ...activity, finishedAt: Date.now(), status: "error", error: failure.toWire(), image: null },
      });

      log.debug(`${op} failed: ${failure.code} ${failure.message}`);
      throw failure;
    }
  }

  private validate(op: Op, rawParams: unknown): Record<string, any> {
    try {
      return COMMANDS[op].params.parse(rawParams ?? {}) as Record<string, any>;
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`);
        throw new LuuCodeError("INVALID_PARAMS", `Invalid parameters for ${op}. ${issues.join("; ")}`, {
          details: { issues },
        });
      }
      throw error;
    }
  }

  private checkPermission(op: Op): void {
    const group = COMMANDS[op].permission;

    if (!this.deps.settings.isAllowed(group)) {
      throw new LuuCodeError("PERMISSION_DENIED", `The "${group}" permission is turned off in Luu Code.`, {
        details: { permission: group },
        hint: "Enable it in the Luu Code permissions panel if this operation is intended.",
      });
    }
  }

  private checkCapability(op: Op, capability: CapabilityId | null, sessionId?: string): void {
    if (capability === null) return;

    const report = this.capabilityReport(sessionId);
    const state = report.capabilities.find((entry) => entry.id === capability);

    if (state?.available) return;

    // Studio being absent is the most common cause and deserves its own code,
    // so an agent can distinguish "not connected" from "cannot ever do this".
    if (!this.deps.sessions.hasSessions()) {
      throw new LuuCodeError("STUDIO_NOT_CONNECTED", "Roblox Studio is not connected to Luu Code.", {
        hint: "Open the place in Studio and approve the connection in the Luu Code panel.",
      });
    }

    throw new LuuCodeError("UNSUPPORTED_CAPABILITY", state?.reason ?? `${capability} is not available right now.`, {
      details: { capability, op },
    });
  }

  private async route(op: Op, params: Record<string, any>, context: ExecuteContext): Promise<unknown> {
    switch (op) {
      case "session.status":
        return this.deps.sessions.status() satisfies SessionStatus;

      case "session.capabilities":
        return this.capabilityReport(context.sessionId);

      case "session.select":
        this.deps.sessions.selectSession(params.sessionId as string);
        return this.deps.sessions.status();

      case "output.get": {
        const buffer = this.deps.output.for(this.sessionKey(context));
        return buffer.query({
          since: params.since,
          limit: params.limit,
          types: params.types,
          contains: params.contains,
        });
      }

      case "output.mark":
        return { cursor: this.deps.output.for(this.sessionKey(context)).mark() };

      case "output.clear":
        return { cleared: this.deps.output.for(this.sessionKey(context)).clear() };

      case "run.start":
        return this.deps.runControl.start(
          { mode: params.mode, waitReady: params.waitReady, timeoutMs: params.timeoutMs },
          context.sessionId,
        );

      case "run.stop":
        return this.deps.runControl.stop(context.sessionId) as Promise<RunState>;

      case "run.restart":
        return this.deps.runControl.restart({ mode: params.mode, timeoutMs: params.timeoutMs }, context.sessionId);

      case "view.screenshot":
        return this.screenshot(params as ScreenshotRequest);

      default:
        return this.sendToStudio(op, params, context);
    }
  }

  private async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    const provider = this.deps.getScreenshotProvider();

    if (!provider) {
      throw new LuuCodeError("UNSUPPORTED_CAPABILITY", `Screen capture is not implemented for ${process.platform}.`, {
        hint: "Run the Luu Code app, which captures through the desktop compositor.",
      });
    }

    return provider(request);
  }

  private async sendToStudio(op: Op, params: Record<string, any>, context: ExecuteContext): Promise<unknown> {
    const outbound = nullsToNilTags(params) as Record<string, unknown>;

    return this.deps.sessions.send(op, outbound, {
      timeoutMs: timeoutFor(op, params),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.realm ? { realm: context.realm } : {}),
    });
  }

  /**
   * Output is stored per Studio session. When no session is named, fall back to
   * the active one so a fresh agent does not have to discover ids first.
   */
  private sessionKey(context: ExecuteContext): string {
    if (context.sessionId) return context.sessionId;
    const status = this.deps.sessions.status();
    return status.activeSessionId ?? "default";
  }
}

function imageFrom(result: unknown): ActivityEvent["image"] {
  const shot = result as ScreenshotResult | null;
  if (!shot?.data) return null;
  return { data: shot.data, mimeType: shot.mimeType, width: shot.width, height: shot.height };
}

function timeoutFor(op: Op, params: Record<string, any>): number {
  if (typeof params.timeoutMs === "number") {
    // The agent's budget is for the operation itself; leave room for the round
    // trip so the server does not give up before Studio answers.
    return params.timeoutMs + 5_000;
  }
  return SLOW_OPS[op] ?? DEFAULT_TIMEOUT_MS;
}
