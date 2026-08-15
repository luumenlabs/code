/**
 * The change journal. Every mutating operation comes back from Studio
 * describing both sides of the write; those are kept here, filed against the
 * Studio window they happened in and the conversation that asked for them.
 *
 * Held in memory. A revertable record only means anything beside the live
 * DataModel it describes: the handles resolve there, the plugin holds the copy
 * of a deleted subtree, and the conflict check compares against that place.
 *
 * The diff does outlive the window — the app keeps its own copy against the
 * conversation, in `Thread.changes`. Both halves are needed: this one to put
 * something back, that one to read it. Do not fold either into the other.
 *
 * The records never reach the agent; the dispatcher strips them in `takeChanges`.
 */
import { randomUUID } from "node:crypto";
import type {
  ChangeDraft,
  ChangeKind,
  ChangeRecord,
  InstanceSnapshot,
  Op,
  RbxValue,
  RevertOutcome,
  ValueChange,
} from "@luumen/code-protocol";

/**
 * How much history one Studio window keeps. The oldest go first when it fills,
 * and `dropped` says so rather than letting the list understate what was done.
 */
const MAX_RECORDS_PER_SESSION = 2000;

const KINDS: ChangeKind[] = ["properties", "attributes", "tags", "rename", "reparent", "create", "delete", "source"];

export interface AppendContext {
  /** The Studio window the change happened in. */
  session: string;
  /** The conversation that asked for it, or null for an external MCP client. */
  chat: string | null;
  activityId: string;
  op: Op;
}

export interface ListFilter {
  session: string;
  chat?: string;
  limit?: number;
  includeReverted?: boolean;
}

export class ChangeJournal {
  private readonly bySession = new Map<string, ChangeRecord[]>();
  private readonly byId = new Map<string, ChangeRecord>();
  private readonly droppedBySession = new Map<string, number>();

  /**
   * Files what a command reported. Returns the records as stored, which is what
   * the app is told about — the drafts have no ids until they get here.
   */
  append(context: AppendContext, drafts: unknown): ChangeRecord[] {
    const normalized = toDrafts(drafts);
    if (normalized.length === 0) return [];

    const at = Date.now();
    const records = normalized.map<ChangeRecord>((draft, index) => ({
      ...draft,
      // The index keeps a batch — five instances deleted in one call — in the
      // order it happened, which is the order a revert has to undo it in.
      id: `ch_${randomUUID().slice(0, 8)}_${index}`,
      op: context.op,
      activityId: context.activityId,
      chat: context.chat,
      session: context.session,
      at: at + index,
    }));

    const existing = this.bySession.get(context.session) ?? [];
    existing.push(...records);

    const overflow = existing.length - MAX_RECORDS_PER_SESSION;
    if (overflow > 0) {
      for (const dropped of existing.splice(0, overflow)) this.byId.delete(dropped.id);
      this.droppedBySession.set(context.session, (this.droppedBySession.get(context.session) ?? 0) + overflow);
    }

    this.bySession.set(context.session, existing);
    for (const record of records) this.byId.set(record.id, record);

    return records;
  }

  list(filter: ListFilter): { records: ChangeRecord[]; total: number; truncated: boolean } {
    const all = this.bySession.get(filter.session) ?? [];
    const includeReverted = filter.includeReverted ?? true;

    const matching = all.filter((record) => {
      if (filter.chat !== undefined && record.chat !== filter.chat) return false;
      if (!includeReverted && record.revertedAt !== undefined) return false;
      return true;
    });

    const limit = filter.limit ?? matching.length;
    // Newest kept when there are too many.
    const records = matching.slice(Math.max(0, matching.length - limit));

    return {
      records,
      total: matching.length + (this.droppedBySession.get(filter.session) ?? 0),
      truncated: records.length < matching.length || (this.droppedBySession.get(filter.session) ?? 0) > 0,
    };
  }

  /**
   * The records behind a set of ids, newest first — the order a revert has to
   * run in. Restoring a deleted instance before undoing the rename that
   * followed it would put it back under the wrong name.
   */
  resolve(ids: string[]): { records: ChangeRecord[]; missing: string[] } {
    const records: ChangeRecord[] = [];
    const missing: string[] = [];

    for (const id of ids) {
      const record = this.byId.get(id);
      if (record) records.push(record);
      else missing.push(id);
    }

    records.sort((left, right) => right.at - left.at);
    return { records, missing };
  }

  /** Stamps the ones that went back, and answers with every record touched. */
  applyOutcomes(outcomes: RevertOutcome[]): ChangeRecord[] {
    const touched: ChangeRecord[] = [];
    const at = Date.now();

    for (const outcome of outcomes) {
      const record = this.byId.get(outcome.id);
      if (!record) continue;

      if (outcome.status === "reverted") record.revertedAt = at;
      touched.push(record);
    }

    return touched;
  }

  /** Forgets a Studio window's history, because the window is gone. */
  dropSession(session: string): boolean {
    const records = this.bySession.get(session);
    if (!records) return false;

    for (const record of records) this.byId.delete(record.id);
    this.bySession.delete(session);
    this.droppedBySession.delete(session);
    return true;
  }
}

/**
 * Pulls the change drafts out of a command result.
 *
 * Mutating results carry them; the agent must not see them. Returns the drafts
 * and the result with the field removed, rather than deleting in place, because
 * the result object is the one already being handed back.
 */
export function takeChanges(result: unknown): { changes: unknown; result: unknown } {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { changes: null, result };
  }

  const source = result as Record<string, unknown>;
  if (!("changes" in source)) return { changes: null, result };

  const { changes, ...rest } = source;
  return { changes, result: rest };
}

/**
 * Reads what the plugin sent.
 *
 * Luau has one table type, so an empty list and an empty object are the same
 * value and arrive as `{}`. Every array here is coerced rather than trusted:
 * this is the one boundary where that is true, and a `.map` on an object
 * somewhere in the renderer is a crash a long way from its cause.
 */
function toDrafts(raw: unknown): ChangeDraft[] {
  return asArray(raw)
    .map(toDraft)
    .filter((draft): draft is ChangeDraft => draft !== null);
}

function toDraft(raw: unknown): ChangeDraft | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as Record<string, any>;

  const kind = source.kind as ChangeKind;
  if (!KINDS.includes(kind)) return null;

  const target = source.target;
  if (!target || typeof target !== "object" || typeof target.path !== "string") return null;

  const draft: ChangeDraft = {
    kind,
    target: {
      handle: String(target.handle ?? ""),
      path: target.path,
      name: String(target.name ?? ""),
      className: String(target.className ?? ""),
      childCount: Number(target.childCount ?? 0),
    },
    parentPath: typeof source.parentPath === "string" ? source.parentPath : null,
    summary: typeof source.summary === "string" ? source.summary : kind,
    revertable: source.revertable === true,
    reason: typeof source.reason === "string" ? source.reason : null,
  };

  if (typeof source.stow === "string") draft.stow = source.stow;

  const properties = valueChanges(source.properties);
  if (properties.length > 0) draft.properties = properties;

  const attributes = valueChanges(source.attributes);
  if (attributes.length > 0) draft.attributes = attributes;

  if (source.tags && typeof source.tags === "object") {
    draft.tags = { added: stringList(source.tags.added), removed: stringList(source.tags.removed) };
  }

  if (source.renamed && typeof source.renamed.before === "string" && typeof source.renamed.after === "string") {
    draft.renamed = { before: source.renamed.before, after: source.renamed.after };
  }

  if (source.moved && typeof source.moved.before === "string" && typeof source.moved.after === "string") {
    draft.moved = { before: source.moved.before, after: source.moved.after };
  }

  if (source.source && typeof source.source === "object") {
    draft.source = {
      before: typeof source.source.before === "string" ? source.source.before : null,
      after: typeof source.source.after === "string" ? source.source.after : "",
      beforeLines: Number(source.source.beforeLines ?? 0),
      afterLines: Number(source.source.afterLines ?? 0),
    };
  }

  if (source.subtree && typeof source.subtree === "object") {
    draft.subtree = {
      className: String(source.subtree.className ?? draft.target.className),
      descendants: Number(source.subtree.descendants ?? 0),
    };
  }

  const snapshot = toSnapshot(source.snapshot);
  if (snapshot) draft.snapshot = snapshot;

  return draft;
}

function toSnapshot(raw: unknown): InstanceSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as Record<string, any>;
  if (typeof source.className !== "string") return null;

  return {
    name: String(source.name ?? ""),
    className: source.className,
    properties: asRecord(source.properties),
    attributes: asRecord(source.attributes),
    tags: stringList(source.tags),
    source: typeof source.source === "string" ? source.source : null,
    children: asArray(source.children)
      .map(toSnapshot)
      .filter((child): child is InstanceSnapshot => child !== null),
    omitted: Number(source.omitted ?? 0),
    ...(source.sourceOmitted === true ? { sourceOmitted: true } : {}),
  };
}

/** Luau sends an empty map as `{}`, which is what an empty object is anyway. */
function asRecord(raw: unknown): Record<string, RbxValue> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, RbxValue>;
}

function valueChanges(raw: unknown): ValueChange[] {
  return asArray(raw)
    .map((entry) => {
      if (entry === null || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      if (typeof source.name !== "string") return null;

      const change: ValueChange = { name: source.name, after: (source.after ?? null) as ValueChange["after"] };
      if ("before" in source) change.before = source.before as ValueChange["before"];
      if (typeof source.unreadable === "string") change.unreadable = source.unreadable;
      return change;
    })
    .filter((entry): entry is ValueChange => entry !== null);
}

function stringList(raw: unknown): string[] {
  return asArray(raw).filter((entry): entry is string => typeof entry === "string");
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}
