/**
 * The change journal: what was done to the DataModel, and how to put it back.
 *
 * There is no working tree here to diff against. A place lives in Studio's
 * memory, the user is editing it at the same time as the agent, and nothing in
 * this product can or should stop them. So this is not a file history — it is a
 * record of individual mutations, captured by the only code that can see both
 * sides of one: the Studio plugin, inside the same recording that puts the edit
 * in Studio's undo stack.
 *
 * That is why every record carries `after` as well as `before`. `before` is what
 * a revert writes; `after` is what the place should still look like if nobody
 * has touched it since. Before anything is put back the two are compared against
 * what is there now, and a change the user has since edited themselves is
 * reported as a conflict rather than quietly overwritten. Reverting is not undo:
 * Studio's undo stack is linear and shared with the user's own work, and the
 * question this answers — "take back that one thing the agent did" — is not one
 * a stack can answer.
 */
import type { Op } from "./commands.js";
import type { InstanceRef } from "./targets.js";
import type { RbxValue } from "./value.js";

/** What sort of mutation a record describes. */
export type ChangeKind =
  | "properties"
  | "attributes"
  | "tags"
  | "rename"
  | "reparent"
  | "create"
  | "delete"
  | "source";

/** One property or attribute, on both sides of the write. */
export interface ValueChange {
  name: string;
  /** Absent when Roblox refused to read the old value. */
  before?: RbxValue;
  after: RbxValue;
  /** Why `before` is missing. A record with any of these cannot be put back. */
  unreadable?: string;
}

export interface SourceChange {
  /** Null when the script was too large to hold a copy of. */
  before: string | null;
  after: string;
  beforeLines: number;
  afterLines: number;
}

/**
 * A whole instance, as it was.
 *
 * Carried by create and delete, which have only one side: there is no
 * before-and-after to line up, so the diff is the entire thing added or the
 * entire thing removed — its class, its properties, its attributes, its tags,
 * its source if it is a script, and everything under it. Anything less is a
 * count of descendants pretending to be a review.
 *
 * Bounded when it is taken, and it says where it stopped. A user reading
 * "Deleted Map" needs to see what was in Map, but a place-sized subtree is not
 * something to put on the wire, and quietly showing the first few children as
 * though they were all of them is the failure worth avoiding.
 */
export interface InstanceSnapshot {
  name: string;
  className: string;
  /** The curated set, the same one dm.get returns. */
  properties: Record<string, RbxValue>;
  attributes: Record<string, RbxValue>;
  tags: string[];
  /** Script source, or null for anything that is not a script. */
  source: string | null;
  children: InstanceSnapshot[];
  /** Children left out because a bound was hit, and how many. */
  omitted: number;
  /** True when the source was too large to carry. */
  sourceOmitted?: boolean;
}

/**
 * A mutation, as the plugin reports it.
 *
 * The plugin knows what changed; it does not know which conversation asked or
 * which activity row the change belongs to. The server stamps those on the way
 * into the journal.
 */
export interface ChangeDraft {
  kind: ChangeKind;
  /** The instance as it was when the change landed. */
  target: InstanceRef;
  /** Its parent at the time, which is where a deleted instance goes back to. */
  parentPath: string | null;
  /** One line, in Roblox language: "Set Position and Anchored". */
  summary: string;

  properties?: ValueChange[];
  attributes?: ValueChange[];
  tags?: { added: string[]; removed: string[] };
  renamed?: { before: string; after: string };
  moved?: { before: string; after: string };
  source?: SourceChange;
  /** For create and delete: how much of the tree the record accounts for. */
  subtree?: { className: string; descendants: number };
  /** For create and delete: the whole instance, so the diff has something to show. */
  snapshot?: InstanceSnapshot;

  /** Whether Studio can put this back at all. */
  revertable: boolean;
  /** Why not, when it cannot. Phrased for the user. */
  reason: string | null;
  /** Key into the plugin's held copy of a destroyed subtree. */
  stow?: string;
}

export interface ChangeRecord extends ChangeDraft {
  id: string;
  /** The operation that made it. */
  op: Op;
  /** The activity row it came from, so the transcript can show it in place. */
  activityId: string;
  /** The conversation that caused it. Null for an external MCP client. */
  chat: string | null;
  /**
   * The Studio window it was made in.
   *
   * A record is only meaningful there: handles, the held copy of a deleted
   * subtree, and the instance it names all belong to that window's DataModel.
   */
  session: string;
  at: number;
  /** Set once it has been put back. The row stays, rather than vanishing. */
  revertedAt?: number;
}

export type RevertStatus = "reverted" | "conflict" | "unavailable" | "failed";

export interface RevertOutcome {
  id: string;
  status: RevertStatus;
  /** What happened. Null only when the change went back cleanly. */
  reason: string | null;
  /** What is in the place now, when the change had moved on since. */
  current?: string;
}

/** Everything one instance had done to it, newest change last. */
export interface ChangeGroup {
  /** Stable across a rename, which the path is not. */
  key: string;
  /** The most recent path, which is where the instance is now. */
  path: string;
  target: InstanceRef;
  records: ChangeRecord[];
  /** How many of them are still standing. */
  pending: number;
}

/**
 * Groups records by the instance they touched.
 *
 * Keyed by handle rather than path: a rename changes the path, and filing the
 * two halves of "renamed, then edited" under different headings would read as
 * two instances when it is one. The heading shows the newest path, because that
 * is where the user will find it in the Explorer.
 */
export function groupChanges(records: ChangeRecord[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();

  for (const record of records) {
    const key = record.target.handle || record.target.path;
    const existing = groups.get(key);

    if (existing) {
      existing.records.push(record);
      existing.path = record.target.path;
      existing.target = record.target;
    } else {
      groups.set(key, { key, path: record.target.path, target: record.target, records: [record], pending: 0 });
    }
  }

  const list = [...groups.values()];

  for (const group of list) {
    group.records.sort((left, right) => left.at - right.at);
    group.pending = group.records.filter(isPending).length;
  }

  // Most recently touched first: the thing the agent just did is the thing you
  // opened the panel to look at.
  return list.sort((left, right) => lastTouched(right) - lastTouched(left));
}

export function isPending(record: ChangeRecord): boolean {
  return record.revertedAt === undefined;
}

function lastTouched(group: ChangeGroup): number {
  return group.records[group.records.length - 1]?.at ?? 0;
}
