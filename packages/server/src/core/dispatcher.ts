/**
 * The single path every Roblox operation takes.
 *
 * Validation, permissions, capability gating, routing, and the activity log all
 * live here so the harness and MCP get identical behaviour. An external agent
 * connected over MCP is not a second-class client; it runs through this exact
 * code. Spec sections 21 and 25.
 */
import { randomUUID } from "node:crypto";
import { COMMANDS, LuuCodeError, isOp, isSilent } from "@luumen/code-protocol";
import type {
  ActivityEvent,
  CapabilityId,
  CapabilityReport,
  Op,
  RevertOutcome,
  RunState,
  ScreenshotResult,
  SessionStatus,
  StudioRealm,
} from "@luumen/code-protocol";
import { ZodError } from "zod";
import { categoryFor, detailFor, instancesFor, titleFor } from "./activity.js";
import { buildCapabilityReport } from "./capabilities.js";
import { takeChanges } from "./changes.js";
import type { ChangeJournal } from "./changes.js";
import type { EventBus } from "./events.js";
import { nilTagsToNulls, nullsToNilTags } from "./normalize.js";
import type { OutputStore } from "./output.js";
import type { RunControl } from "./runControl.js";
import type { SessionRegistry, SessionTarget } from "./sessions.js";
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
  // A revert is a batch: a hundred records is one request, and each one reads
  // the live value back before it writes.
  "changes.apply": 60_000,
};

export interface ExecuteContext {
  origin: ActivityEvent["origin"];
  sessionId?: string;
  realm?: StudioRealm;
  /**
   * The conversation this was issued for, when the caller knows of one.
   *
   * Several coding agents share this server, one per chat in the app, and the
   * operation stream is common to all of them. This is how their work is told
   * apart. An external MCP client has no chat and sends nothing.
   */
  chat?: string;
}

export interface DispatcherDeps {
  sessions: SessionRegistry;
  settings: SettingsStore;
  bus: EventBus;
  output: OutputStore;
  changes: ChangeJournal;
  runControl: RunControl;
  nativeInput: NativeInput;
  getScreenshotProvider: () => ScreenshotProvider | null;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  capabilityReport(target: SessionTarget = {}): CapabilityReport {
    return buildCapabilityReport({
      studio: this.deps.sessions.capabilitiesFor(target),
      studioConnected: this.deps.sessions.hasSessions(),
      run: this.deps.sessions.runStateFor(target),
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
    const silent = isSilent(op);
    const params = this.validate(op, rawParams);

    this.checkPermission(op);
    this.checkCapability(op, spec.capability, context);

    const activity: ActivityEvent = {
      id: `a_${randomUUID().slice(0, 8)}`,
      op,
      origin: context.origin,
      chat: context.chat ?? null,
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

    // A silent operation is the app reading its own bookkeeping, and produces
    // no row at either end — a running row that is never resolved would be
    // worse than none at all.
    if (!silent) this.deps.bus.emit({ type: "activity", activity });

    try {
      const raw = await this.route(op, params, context);
      // The journal comes off here, before anything else sees the result: what
      // the agent gets back must not carry the old source of the script it just
      // rewrote.
      const { changes, result } = takeChanges(raw);
      const normalized = nilTagsToNulls(result);

      this.journal(op, changes, activity, context);

      if (!silent) {
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
      }

      return normalized;
    } catch (error) {
      const failure = LuuCodeError.from(error);

      if (!silent) {
        this.deps.bus.emit({
          type: "activity",
          activity: { ...activity, finishedAt: Date.now(), status: "error", error: failure.toWire(), image: null },
        });
      }

      log.debug(`${op} failed: ${failure.code} ${failure.message}`);
      throw failure;
    }
  }

  /**
   * Files what an operation changed, and tells the app.
   *
   * Failures are not journalled: an operation that raised either did nothing or
   * was rolled back by the recording it ran inside, and a record of a change
   * that did not happen is a revert button that breaks something.
   */
  private journal(op: Op, changes: unknown, activity: ActivityEvent, context: ExecuteContext): void {
    if (changes === null || changes === undefined) return;

    const records = this.deps.changes.append(
      {
        session: this.sessionKey(context),
        chat: context.chat ?? null,
        activityId: activity.id,
        op,
      },
      // The plugin encodes an absent value as a Nil tag, the same as any other
      // value on the wire, so the journal is normalised with everything else.
      nilTagsToNulls(changes),
    );

    if (records.length > 0) this.deps.bus.emit({ type: "changes", records });
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

  private checkCapability(op: Op, capability: CapabilityId | null, context: ExecuteContext): void {
    if (capability === null) return;

    const report = this.capabilityReport(context);
    const state = report.capabilities.find((entry) => entry.id === capability);

    if (state?.available) return;

    // Being unable to reach the Studio window at all is the real story, and it
    // deserves its own code: an agent can act on "not connected" or "that window
    // closed", but "capability unavailable" sends it looking for a Studio
    // feature that was never the problem. Checked after the report so anything
    // that works without Studio, like a screenshot, is untouched.
    const unreachable = this.deps.sessions.targetError(context);
    if (unreachable) throw unreachable;

    throw new LuuCodeError("UNSUPPORTED_CAPABILITY", state?.reason ?? `${capability} is not available right now.`, {
      details: { capability, op },
    });
  }

  private async route(op: Op, params: Record<string, any>, context: ExecuteContext): Promise<unknown> {
    switch (op) {
      case "session.status":
        return this.deps.sessions.status() satisfies SessionStatus;

      case "session.capabilities":
        return this.capabilityReport(context);

      case "session.select":
        // params.chat lets an agent move a conversation other than its own;
        // context.chat is the ordinary case, where it moves itself.
        this.deps.sessions.selectSession(params.sessionId as string, (params.chat as string | undefined) ?? context.chat);
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
          context,
        );

      case "run.stop":
        return this.deps.runControl.stop(context) as Promise<RunState>;

      case "run.restart":
        return this.deps.runControl.restart({ mode: params.mode, timeoutMs: params.timeoutMs }, context);

      case "view.screenshot":
        return this.screenshot(params as ScreenshotRequest);

      case "changes.list":
        return this.deps.changes.list({
          session: this.sessionKey(context),
          ...(params.chat ? { chat: params.chat as string } : {}),
          limit: params.limit as number,
          includeReverted: params.includeReverted as boolean,
        });

      case "changes.revert":
        return this.revert(params.ids as string[], params.force === true, context);

      default:
        return this.sendToStudio(op, params, context);
    }
  }

  /**
   * Puts recorded changes back.
   *
   * The work is Studio's — only it can read the live values, and only it holds
   * the copies of deleted subtrees — so this resolves the ids, hands the records
   * over, and files what came back. Ordering is the one thing that cannot be
   * left to the caller: `resolve` returns newest first, because a run of changes
   * to one instance only composes when the last write is taken back first.
   */
  private async revert(
    ids: string[],
    force: boolean,
    context: ExecuteContext,
  ): Promise<{ outcomes: RevertOutcome[]; reverted: number }> {
    const { records, missing } = this.deps.changes.resolve(ids);

    // An id the journal has never heard of is a bug in the caller or a session
    // that has been dropped, and either way it is not something to skip past.
    if (records.length === 0) {
      throw new LuuCodeError("TARGET_NOT_FOUND", `None of those ${ids.length} changes are in this session's history.`, {
        details: { missing },
        hint: "The journal is kept for as long as the app and the Studio window stay connected. Call changes.list for what is still there.",
      });
    }

    const alreadyDone = records.filter((record) => record.revertedAt !== undefined);
    const pending = records.filter((record) => record.revertedAt === undefined);

    const outcomes: RevertOutcome[] = [
      ...missing.map<RevertOutcome>((id) => ({ id, status: "unavailable", reason: "No longer in this session's history." })),
      ...alreadyDone.map<RevertOutcome>((record) => ({ id: record.id, status: "reverted", reason: "Already put back." })),
    ];

    if (pending.length > 0) {
      const applied = (await this.sendToStudio("changes.apply", { records: pending, force }, context)) as {
        outcomes?: RevertOutcome[];
      };
      outcomes.push(...normalizeOutcomes(applied?.outcomes));
    }

    const touched = this.deps.changes.applyOutcomes(outcomes);
    if (touched.length > 0) this.deps.bus.emit({ type: "changes", records: touched });

    return { outcomes, reverted: outcomes.filter((entry) => entry.status === "reverted").length };
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
      ...(context.chat ? { chat: context.chat } : {}),
      ...(context.realm ? { realm: context.realm } : {}),
    });
  }

  /**
   * Output is stored per Studio session, and read through the same routing as
   * everything else — a chat reads the output of the window it is working in,
   * not of whichever one is selected on screen.
   */
  private sessionKey(context: ExecuteContext): string {
    return this.deps.sessions.sessionKeyFor(context);
  }
}

/**
 * Studio's answer, made safe to read.
 *
 * Luau omits a nil field rather than sending null, so an outcome with nothing to
 * say arrives without a `reason` at all — and every consumer of this type is
 * entitled to find one there.
 */
function normalizeOutcomes(raw: unknown): RevertOutcome[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      id: String(entry.id ?? ""),
      status: (entry.status as RevertOutcome["status"]) ?? "failed",
      reason: typeof entry.reason === "string" ? entry.reason : null,
      ...(typeof entry.current === "string" ? { current: entry.current } : {}),
    }))
    .filter((outcome) => outcome.id.length > 0);
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
