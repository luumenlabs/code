/**
 * The single path every Roblox operation takes.
 *
 * Validation, permissions, capability gating, routing, and the activity log all
 * live here so the harness and MCP get identical behaviour. An external agent
 * connected over MCP is not a second-class client; it runs through this exact
 * code. Spec sections 21 and 25.
 */
import { randomUUID } from "node:crypto";
import {
  BATCHABLE_OPS,
  COMMANDS,
  LuuCodeError,
  isOp,
  isSilent,
  refuseTool,
  toolNameFor,
  unwrapRules,
  wrapRules,
} from "@luumen/code-protocol";
import type {
  ActivityEvent,
  BatchStep,
  BatchableOp,
  CapabilityId,
  CapabilityReport,
  InstanceRef,
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
import { encodePng } from "./png.js";
import type { RunControl } from "./runControl.js";
import type { PeerRef, SessionRegistry, SessionTarget } from "./sessions.js";
import type { SettingsStore } from "../config/settings.js";
import type { DesktopCaptureProvider } from "../native/screenshot.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("dispatch");

const DEFAULT_TIMEOUT_MS = 15_000;
/** Operations that legitimately take longer than a normal round trip. */
const SLOW_OPS: Partial<Record<Op, number>> = {
  "dm.tree": 30_000,
  "dm.search": 30_000,
  "script.list": 30_000,
  // One pass over every script's source, and the source of a large place is the
  // largest thing in it.
  "script.grep": 60_000,
  // The same pass, and then a compile of each script it rewrote.
  "script.replace": 90_000,
  "input.text": 60_000,
  // Capture waits on a rendered frame, then reads the pixels back a tile at a
  // time. Both are slower than a round trip and neither is the plugin hanging.
  "view.screenshot": 45_000,
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
  getDesktopCaptureProvider: () => DesktopCaptureProvider | null;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  capabilityReport(target: SessionTarget = {}): CapabilityReport {
    return buildCapabilityReport({
      studio: this.deps.sessions.capabilitiesFor(target),
      studioConnected: this.deps.sessions.hasSessions(),
      run: this.deps.sessions.runStateFor(target),
      desktopCaptureAvailable: this.deps.getDesktopCaptureProvider() !== null,
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
      const raw = await this.route(op, params, context, activity);
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

  /**
   * Reported differently because the fix is different: a whole category being
   * off, versus one tool under a category that is otherwise on.
   */
  private checkPermission(op: Op): void {
    const refusal = refuseTool(this.deps.settings.policy, op);
    if (!refusal) return;

    if (refusal.reason === "group") {
      throw new LuuCodeError("PERMISSION_DENIED", `The "${refusal.group}" permission is turned off in Luu Code.`, {
        details: { permission: refusal.group, op },
        hint: "Enable it in the Luu Code permissions panel if this operation is intended.",
      });
    }

    throw new LuuCodeError("PERMISSION_DENIED", `The ${toolNameFor(op) ?? op} tool is turned off in Luu Code.`, {
      details: { op, tool: toolNameFor(op), permission: COMMANDS[op].permission },
      hint: "Other tools in this group are still available. Turn it back on under Settings → Permissions.",
    });
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

  /**
   * `activity` is threaded through for one operation: a batch that stops
   * halfway has already edited the place, and it has to file those changes
   * before it fails. Everything else journals on the way out of `execute`.
   */
  private async route(op: Op, params: Record<string, any>, context: ExecuteContext, activity: ActivityEvent): Promise<unknown> {
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
        return this.deps.runControl.stop({ timeoutMs: params.timeoutMs }, context) as Promise<RunState>;

      case "run.restart":
        return this.deps.runControl.restart({ mode: params.mode, timeoutMs: params.timeoutMs }, context);

      case "run.multiplayer":
        return this.deps.runControl.multiplayer(
          {
            action: params.action,
            players: params.players,
            client: params.client,
            testArgs: params.testArgs,
            value: params.value,
            timeoutMs: params.timeoutMs,
          },
          context,
        );

      case "dm.batch":
        return this.batch(
          params.operations as Array<{ op: BatchableOp; params: Record<string, unknown> }>,
          params.stopOnError === true,
          context,
          activity,
        );

      case "view.screenshot":
        return this.screenshot(params as { source: "viewport" | "window" | "screen"; maxWidth: number }, context);

      case "changes.list":
        return this.deps.changes.list({
          session: this.sessionKey(context),
          ...(params.chat ? { chat: params.chat as string } : {}),
          limit: params.limit as number,
          includeReverted: params.includeReverted as boolean,
        });

      // The document's storage format is the protocol's, not Studio's, so the
      // plugin moves a script source and the wrapper is put on and taken off
      // here. Fields are read defensively: a plugin too old to know the
      // operation is the same answer as a place with no rules.
      case "rules.get": {
        const answer = (await this.sendToStudio(op, params, context)) as Record<string, unknown>;
        const source = typeof answer.source === "string" ? answer.source : null;

        return {
          present: source !== null,
          path: typeof answer.path === "string" ? answer.path : null,
          text: source === null ? null : unwrapRules(source),
          conflict: typeof answer.conflict === "string" ? answer.conflict : null,
        };
      }

      case "rules.set":
        return this.sendToStudio(op, { source: wrapRules(params.text as string) }, context);

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

  /**
   * Every step is validated here against the same schema it has on its own, so a
   * typo in step forty is caught before step one touches the place. The journal
   * still gets a record per mutation: a batch is a transport detail, and revert
   * works at the level of the change.
   */
  private async batch(
    operations: Array<{ op: BatchableOp; params: Record<string, unknown> }>,
    stopOnError: boolean,
    context: ExecuteContext,
    activity: ActivityEvent,
  ): Promise<unknown> {
    const prepared = operations.map((entry, index) => {
      if (!(BATCHABLE_OPS as readonly string[]).includes(entry.op)) {
        throw new LuuCodeError("INVALID_PARAMS", `Step ${index + 1}: ${entry.op} cannot appear in a batch.`, {
          details: { allowed: BATCHABLE_OPS },
        });
      }

      try {
        return { op: entry.op, params: COMMANDS[entry.op].params.parse(entry.params ?? {}) as Record<string, unknown> };
      } catch (error) {
        if (error instanceof ZodError) {
          const issues = error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`);
          throw new LuuCodeError("INVALID_PARAMS", `Step ${index + 1} (${entry.op}) is invalid. ${issues.join("; ")}`, {
            details: { step: index + 1, op: entry.op, issues },
          });
        }
        throw error;
      }
    });

    const result = (await this.sendToStudio("dm.batch", { operations: prepared, stopOnError }, context)) as {
      steps?: BatchStep[];
      instances?: InstanceRef[];
    };

    const steps = result?.steps ?? [];
    const first = steps.find((step) => step.status === "failed");

    if (!first || !stopOnError) return result;

    // A batch that got halfway is not a batch that worked, so it fails — but the
    // steps that did land are real edits to the place, and they have to reach the
    // journal before this throws. `execute` only journals what it gets back, and
    // it is not getting anything back. An edit with no record is one the user
    // cannot see and cannot take away.
    const { changes } = takeChanges(result);
    this.journal("dm.batch", changes, activity, context);

    throw new LuuCodeError(
      first.error?.code ?? "INTERNAL",
      `Step ${first.index + 1} (${first.op}) failed: ${first.error?.message ?? "unknown error"}`,
      {
        details: { steps, applied: steps.filter((step) => step.status === "ok").length },
        hint: first.error?.hint ?? "Earlier steps have already been applied; changes.list shows what landed.",
      },
    );
  }

  /**
   * The in-engine path is the default and never silently falls back to the
   * desktop one: they photograph different things, and "is this GUI centred?"
   * gets a wrong answer from the wrong picture. A failure names the alternative.
   */
  private async screenshot(
    request: { source: "viewport" | "window" | "screen"; maxWidth: number },
    context: ExecuteContext,
  ): Promise<ScreenshotResult> {
    if (request.source === "viewport") return this.captureViewport(request.maxWidth, context);

    const provider = this.deps.getDesktopCaptureProvider();

    if (!provider) {
      throw new LuuCodeError("UNSUPPORTED_CAPABILITY", `Desktop capture is not implemented for ${process.platform}.`, {
        hint: 'Use source "viewport", which captures through Studio itself.',
      });
    }

    return provider({ source: request.source, maxWidth: request.maxWidth });
  }

  /**
   * The in-engine path, aimed at whichever peer has a window to photograph.
   *
   * During a playtest that is the client, because the server DataModel does not
   * render at all; in edit mode it is the edit peer. A peer whose window is
   * minimised is skipped rather than sent to, since capture there waits for a
   * frame that never arrives and then reports a timeout that says nothing about
   * the real cause.
   */
  private async captureViewport(maxWidth: number, context: ExecuteContext): Promise<ScreenshotResult> {
    let peers: PeerRef[];

    try {
      peers = this.deps.sessions.peers(context);
    } catch (error) {
      // Studio being unreachable is a fine reason to fail, but the caller asked
      // for a picture and there may still be a way to take one. Say so, rather
      // than leaving them with a connection error and no next step.
      throw new LuuCodeError("SCREENSHOT_FAILED", LuuCodeError.from(error).message, {
        hint: this.deps.getDesktopCaptureProvider()
          ? 'Capturing the viewport needs the Studio plugin. Use source "window" to photograph the Studio window from the desktop instead.'
          : "Open the place in Studio and approve the Luu Code connection panel.",
        cause: error,
      });
    }

    const rendering = (peer: PeerRef) => peer.realm !== "server" && peer.run.rendering !== false;

    const chosen =
      peers.find((peer) => peer.run.running && peer.realm === "client" && rendering(peer)) ??
      peers.find((peer) => !peer.run.running && rendering(peer)) ??
      peers.find(rendering);

    if (!chosen) {
      throw new LuuCodeError("SCREENSHOT_FAILED", "No connected Studio DataModel is drawing a viewport to capture.", {
        details: { peers: peers.map((peer) => ({ realm: peer.realm, running: peer.run.running, rendering: peer.run.rendering })) },
        hint: 'The Studio window is probably minimized. Restore it, or capture the desktop with source "window".',
      });
    }

    const raw = (await this.deps.sessions.send(
      "view.screenshot",
      { maxWidth },
      { timeoutMs: SLOW_OPS["view.screenshot"] ?? DEFAULT_TIMEOUT_MS, peer: chosen, ...pick(context) },
    )) as { pixels: string; width: number; height: number; realm: StudioRealm };

    const pixels = Buffer.from(raw.pixels, "base64");

    return {
      data: encodePng(pixels, raw.width, raw.height).toString("base64"),
      mimeType: "image/png",
      width: raw.width,
      height: raw.height,
      capturedAt: Date.now(),
      source: "viewport",
      realm: raw.realm,
    };
  }

  private async sendToStudio(op: Op, params: Record<string, any>, context: ExecuteContext): Promise<unknown> {
    const outbound = nullsToNilTags(params) as Record<string, unknown>;
    const realm = realmFor(params) ?? context.realm;

    return this.deps.sessions.send(op, outbound, {
      timeoutMs: timeoutFor(op, params),
      ...pick(context),
      ...(realm ? { realm } : {}),
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

/** The SessionTarget half of an execute context. */
function pick(context: ExecuteContext): SessionTarget {
  return {
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.chat ? { chat: context.chat } : {}),
  };
}

/**
 * A realm the caller asked for by parameter, which outranks the one implied by
 * the connection they happen to be on.
 *
 * `runtime.exec` is the operation that needs this. During a playtest the client
 * and the server see different worlds, and running a probe in whichever
 * DataModel was selected answered about the wrong one roughly half the time —
 * plausibly enough that the mistake was not obvious.
 */
function realmFor(params: Record<string, any>): StudioRealm | undefined {
  const realm = params.realm;
  if (realm === "edit" || realm === "server" || realm === "client") return realm;
  return undefined;
}

function timeoutFor(op: Op, params: Record<string, any>): number {
  if (typeof params.timeoutMs === "number") {
    // The agent's budget is for the operation itself; leave room for the round
    // trip so the server does not give up before Studio answers.
    return params.timeoutMs + 5_000;
  }

  // An operation that watches for a span cannot answer during it. Without this
  // a thirty-second measurement is abandoned at fifteen, and the failure names
  // Studio rather than the duration the caller chose.
  if (typeof params.durationMs === "number") {
    return params.durationMs + (SLOW_OPS[op] ?? DEFAULT_TIMEOUT_MS);
  }

  return SLOW_OPS[op] ?? DEFAULT_TIMEOUT_MS;
}
