/**
 * A change, written out as the two versions of a file.
 *
 * A DataModel change is not text, and a diff needs text — so this renders the
 * instance as Luau on both sides of the write and hands the pair to
 * `@pierre/diffs`, which does the aligning and the highlighting. Nothing here
 * compares anything; that is the library's job and it is better at it.
 *
 * The rendered form is deliberately Luau-shaped rather than a bespoke notation.
 * `Anchored = true` and `Attributes.Owner = "shop"` are what the user would
 * write to make the change themselves, they highlight as code because they are
 * code, and a create reads as the script you would need to build the thing.
 */
import { parseDiffFromFile } from "@pierre/diffs";
import type { ChangeRecord, InstanceSnapshot, RbxValue, ValueChange } from "@luumen/code-protocol";
import { formatValue, isPending } from "@luumen/code-protocol";

export interface ChangeDocument {
  /** Shown as the filename in the diff header. */
  name: string;
  /** Null means the file did not exist on that side — a create, or a delete. */
  before: string | null;
  after: string | null;
}

/** Lines added and removed, which is how every other diff in the world counts. */
export interface ChangeStats {
  added: number;
  removed: number;
}

/**
 * What a row calls a change: a thing, and which part of it moved.
 *
 * The plugin also writes a sentence — "Set Anchored, CanCollide and 2 more" —
 * and that sentence is the right thing to hand an agent, to copy out, and to
 * put in the activity log. It is the wrong thing to stack forty of down a
 * panel: prose does not scan, does not align, and buries the two words that
 * identify the row under the grammar around them. `record.summary` is still
 * there for the places that want a sentence; this is for the places that want
 * a list.
 */
export interface ChangeLabel {
  /** The instance, or the script file. */
  name: string;
  /** Which part of it changed: property names, a class, a tag. */
  detail: string | null;
}

/**
 * Luau, always.
 *
 * Even the synthesised documents: they are property assignments, which is Luau,
 * and naming them anything else would turn the one thing the highlighter is
 * good at into dead weight.
 */
export function changeDocument(record: ChangeRecord): ChangeDocument | null {
  const leaf = record.target.name || record.target.path;

  switch (record.kind) {
    case "source": {
      const change = record.source;
      if (!change) return null;
      return { name: `${leaf}.luau`, before: change.before, after: change.after };
    }

    case "create":
      return {
        name: `${leaf}.luau`,
        before: null,
        after: record.snapshot ? renderSnapshot(record.snapshot) : renderStub(record),
      };

    case "delete":
      return {
        name: `${leaf}.luau`,
        before: record.snapshot ? renderSnapshot(record.snapshot) : renderStub(record),
        after: null,
      };

    case "properties":
      return sides(leaf, record.properties ?? [], "");

    case "attributes":
      return sides(leaf, record.attributes ?? [], "Attributes.");

    case "tags": {
      const added = record.tags?.added ?? [];
      const removed = record.tags?.removed ?? [];
      // Both sides carry every tag the operation touched, so the ones that were
      // already there sit in the diff as context rather than vanishing.
      const before = [...removed].sort();
      const after = [...added].sort();
      return {
        name: `${leaf}.luau`,
        before: renderTags(before),
        after: renderTags(after),
      };
    }

    case "rename":
      if (!record.renamed) return null;
      return {
        name: `${leaf}.luau`,
        before: `Name = ${quote(record.renamed.before)}\n`,
        after: `Name = ${quote(record.renamed.after)}\n`,
      };

    case "reparent":
      if (!record.moved) return null;
      return {
        name: `${leaf}.luau`,
        before: `Parent = ${record.moved.before}\n`,
        after: `Parent = ${record.moved.after}\n`,
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bundles: the change a run of records adds up to
// ---------------------------------------------------------------------------

/**
 * Records that describe the same thing, and can therefore be read as one.
 *
 * A `create` and a `source` are different operations on the same document — the
 * file — and comparing the first one's before with the last one's after gives
 * the change the file actually underwent. A `rename` is not: its document is a
 * line of Luau saying what the instance is called, and folding that into a
 * script's diff would produce a comparison between two unrelated things.
 *
 * So records merge within a family and never across one.
 */
type Family = "document" | ChangeRecord["kind"];

function family(kind: ChangeRecord["kind"]): Family {
  return kind === "create" || kind === "source" || kind === "delete" ? "document" : kind;
}

export interface ChangeBundle {
  /** Stable for the same instance, family, and revert state. */
  key: string;
  /** Oldest first, and never empty. */
  records: ChangeRecord[];
  /** The one the row draws its icon from. */
  kind: ChangeRecord["kind"];
}

/**
 * Changes, as the changes they add up to.
 *
 * An agent that writes a script and then fixes a line in it has performed two
 * operations and made one change, and the transcript was showing the two: a
 * create whose diff is the whole file, followed by an edit whose diff is a line
 * of it. Nobody reviews that. What they want is the file, as it now stands,
 * against what was there before — which is the first record's before and the
 * last record's after.
 *
 * Grouped by instance rather than by adjacency: a turn that edits A, then B,
 * then A again made two changes, not three, and the row for A belongs where A
 * was first touched.
 *
 * Revert state is part of the key, which is what keeps the merge honest. Put
 * one record of a bundle back and the row splits in two — what has been undone
 * and what still stands — because a cumulative diff of a half-reverted run
 * would describe a place that does not exist.
 */
export function bundleChanges(records: ChangeRecord[]): ChangeBundle[] {
  const bundles = new Map<string, ChangeBundle>();

  for (const record of records) {
    const instance = record.target.handle || record.target.path;
    const key = `${instance}|${family(record.kind)}|${isPending(record) ? "live" : "reverted"}`;

    const existing = bundles.get(key);
    if (existing) {
      existing.records.push(record);
      existing.kind = dominant(existing.kind, record.kind);
      continue;
    }

    bundles.set(key, { key, records: [record], kind: record.kind });
  }

  return [...bundles.values()];
}

/**
 * Which kind names the bundle.
 *
 * A file that was created and then edited was created — that is the fact worth
 * the icon, and the edits are how it reached its final state. A file that was
 * created and then deleted is a delete, for the same reason: it is the outcome.
 */
function dominant(current: ChangeRecord["kind"], next: ChangeRecord["kind"]): ChangeRecord["kind"] {
  if (current === "delete" || next === "delete") return "delete";
  if (current === "create" || next === "create") return "create";
  return next;
}

/**
 * A bundle from records named explicitly, for the viewer.
 *
 * The row has already decided what belongs together and passed its ids along;
 * re-deriving that here would re-split the run the moment one of its records
 * was put back, and quietly show half of the diff the user opened.
 */
export function bundleFrom(records: ChangeRecord[]): ChangeBundle | null {
  const first = records[0];
  if (!first) return null;

  return {
    key: records.map((record) => record.id).join("|"),
    records,
    kind: records.reduce<ChangeRecord["kind"]>((current, record) => dominant(current, record.kind), first.kind),
  };
}

export function bundleDocument(bundle: ChangeBundle): ChangeDocument | null {
  const records = bundle.records;
  const first = records[0]!;
  const last = records[records.length - 1]!;

  if (records.length === 1) return changeDocument(first);

  const leaf = last.target.name || last.target.path;

  switch (family(first.kind)) {
    case "document": {
      const before = changeDocument(first);
      const after = changeDocument(last);
      if (!before && !after) return null;

      return {
        name: (after ?? before)!.name,
        before: before ? before.before : null,
        after: after ? after.after : null,
      };
    }

    case "properties":
      return sides(leaf, mergeValues(records.map((record) => record.properties ?? [])), "");

    case "attributes":
      return sides(leaf, mergeValues(records.map((record) => record.attributes ?? [])), "Attributes.");

    case "tags": {
      const added = new Set<string>();
      const removed = new Set<string>();

      for (const record of records) {
        for (const tag of record.tags?.added ?? []) {
          added.add(tag);
          removed.delete(tag);
        }
        for (const tag of record.tags?.removed ?? []) {
          removed.add(tag);
          added.delete(tag);
        }
      }

      return {
        name: `${leaf}.luau`,
        before: renderTags([...removed].sort()),
        after: renderTags([...added].sort()),
      };
    }

    case "rename":
      if (!first.renamed || !last.renamed) return null;
      return {
        name: `${leaf}.luau`,
        before: `Name = ${quote(first.renamed.before)}\n`,
        after: `Name = ${quote(last.renamed.after)}\n`,
      };

    case "reparent":
      if (!first.moved || !last.moved) return null;
      return {
        name: `${leaf}.luau`,
        before: `Parent = ${first.moved.before}\n`,
        after: `Parent = ${last.moved.after}\n`,
      };

    default:
      return changeDocument(last);
  }
}

/**
 * One entry per name: where it started, and where it ended up.
 *
 * `Anchored` set twice in a turn is one property with one before and one after.
 * Listing it twice is the per-operation view again, in miniature.
 */
function mergeValues(lists: ValueChange[][]): ValueChange[] {
  const merged = new Map<string, ValueChange>();

  for (const list of lists) {
    for (const value of list) {
      const existing = merged.get(value.name);
      // The earliest `before` is the one that was there before the turn; the
      // latest `after` is what is there now.
      merged.set(value.name, existing ? { ...existing, after: value.after } : value);
    }
  }

  return [...merged.values()];
}

/** True when there is a document worth opening the row for. */
export function hasDocument(bundle: ChangeBundle): boolean {
  const document = bundleDocument(bundle);
  return document !== null && (document.before !== null || document.after !== null);
}

/**
 * What the row calls a bundle.
 *
 * Built from the merged data rather than from the last record, so a turn that
 * set `Anchored` and then `CanCollide` reads as both rather than as the one it
 * happened to finish on.
 */
export function bundleLabel(bundle: ChangeBundle): ChangeLabel {
  const records = bundle.records;
  const last = records[records.length - 1]!;

  if (records.length === 1) return changeLabel(last);

  const leaf = last.target.name || last.target.path;

  switch (family(last.kind)) {
    case "document":
      return { name: `${leaf}.luau`, detail: null };

    case "properties":
      return { name: leaf, detail: names(mergeValues(records.map((r) => r.properties ?? [])).map((v) => v.name)) };

    case "attributes":
      return {
        name: leaf,
        detail: names(mergeValues(records.map((r) => r.attributes ?? [])).map((v) => `@${v.name}`)),
      };

    default:
      return changeLabel(last);
  }
}

export function changeLabel(record: ChangeRecord): ChangeLabel {
  const leaf = record.target.name || record.target.path;

  switch (record.kind) {
    case "source":
      return { name: `${leaf}.luau`, detail: null };

    case "properties":
      return { name: leaf, detail: names((record.properties ?? []).map((value) => value.name)) };

    case "attributes":
      // The sigil is the one Roblox itself uses in the Properties pane, and it
      // is what stops "Owner" reading as a property when it is an attribute.
      return { name: leaf, detail: names((record.attributes ?? []).map((value) => `@${value.name}`)) };

    case "tags":
      return {
        name: leaf,
        detail: names([
          ...(record.tags?.added ?? []).map((tag) => `+#${tag}`),
          ...(record.tags?.removed ?? []).map((tag) => `−#${tag}`),
        ]),
      };

    case "rename":
      return { name: record.renamed?.after ?? leaf, detail: "Name" };

    case "reparent":
      return { name: leaf, detail: "Parent" };

    case "create":
    case "delete":
      return { name: leaf, detail: record.target.className };

    default:
      return { name: leaf, detail: null };
  }
}

/** Three, then a count. A row is a label, not an inventory. */
function names(list: string[]): string | null {
  if (list.length === 0) return null;
  if (list.length <= 3) return list.join(" ");
  return `${list.slice(0, 3).join(" ")} +${list.length - 3}`;
}

const NOTHING: ChangeStats = { added: 0, removed: 0 };

/**
 * Beyond this, the counts are taken from the line totals rather than a diff.
 *
 * The number is deliberately generous — a 200KB script still gets a real count.
 * What it rules out is the pathological case: a turn that rewrote a dozen huge
 * files, every row of which would otherwise run the diff algorithm on mount,
 * synchronously, before anything appeared on screen.
 */
const MAX_DIFFED = 400_000;

/**
 * Counted once per record, then remembered.
 *
 * A journalled record never changes — the id is enough of a key — and the same
 * rows are rendered on every keystroke in the composer, every output line, and
 * every scroll. Diffing a script on each of those is not a cost worth paying
 * for a number in the corner of a row.
 */
const COUNTED = new Map<string, ChangeStats>();

export function changeStats(record: ChangeRecord): ChangeStats {
  return remembered(record.id, () => changeDocument(record));
}

/**
 * The counts for the merged change, which are not the sum of the parts.
 *
 * A line written by the create and then rewritten by the edit is one added
 * line, and adding the two records' own counts would report it as two added
 * and one removed — a bigger diff than the one on screen.
 */
export function bundleStats(bundle: ChangeBundle): ChangeStats {
  return remembered(bundle.records.map((record) => record.id).join("|"), () => bundleDocument(bundle));
}

function remembered(key: string, build: () => ChangeDocument | null): ChangeStats {
  const cached = COUNTED.get(key);
  if (cached) return cached;

  const stats = count(build());
  // A guard against a session that never ends, not a policy: the next render
  // pays for the handful of rows actually on screen and the map refills.
  if (COUNTED.size > 1_000) COUNTED.clear();
  COUNTED.set(key, stats);
  return stats;
}

function count(document: ChangeDocument | null): ChangeStats {
  if (!document) return NOTHING;

  const { name, before, after } = document;
  if (before === after) return NOTHING;
  if (before === null) return { added: lineCount(after ?? ""), removed: 0 };
  if (after === null) return { added: 0, removed: lineCount(before) };

  if (before.length + after.length > MAX_DIFFED) {
    return { added: lineCount(after), removed: lineCount(before) };
  }

  try {
    const parsed = parseDiffFromFile({ name, contents: before }, { name, contents: after });
    let added = 0;
    let removed = 0;

    for (const hunk of parsed.hunks) {
      added += hunk.additionLines;
      removed += hunk.deletionLines;
    }

    return { added, removed };
  } catch {
    // The diff is the library's problem and it renders the same pair; a count
    // it could not produce is not worth failing a row over.
    return NOTHING;
  }
}

/** Lines in a document, not counting the one a trailing newline implies. */
export function lineCount(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.length === 0 ? 0 : body.split("\n").length;
}

function sides(leaf: string, values: ValueChange[], prefix: string): ChangeDocument {
  const ordered = [...values].sort((left, right) => left.name.localeCompare(right.name));

  const before = ordered
    .map((value) =>
      value.unreadable
        ? `-- ${prefix}${value.name} could not be read before the write`
        : `${prefix}${value.name} = ${formatValue(value.before ?? null)}`,
    )
    .join("\n");

  const after = ordered.map((value) => `${prefix}${value.name} = ${formatValue(value.after)}`).join("\n");

  return { name: `${leaf}.luau`, before: `${before}\n`, after: `${after}\n` };
}

function renderTags(tags: string[]): string {
  if (tags.length === 0) return "Tags = {}\n";
  return `Tags = {\n${tags.map((tag) => `\t${quote(tag)},`).join("\n")}\n}\n`;
}

/** What a create or delete looked like, when the plugin could not snapshot it. */
function renderStub(record: ChangeRecord): string {
  return `-- ${record.target.path}\nlocal instance = Instance.new(${quote(record.target.className)})\n`;
}

/**
 * The whole instance, as the Luau that would build it.
 *
 * Children are nested by indentation rather than flattened, because the shape of
 * the tree is half of what a deleted Model was.
 */
function renderSnapshot(node: InstanceSnapshot, depth = 0): string {
  const pad = "\t".repeat(depth);
  const lines: string[] = [`${pad}-- ${node.className} ${quote(node.name)}`];

  for (const [name, value] of sorted(node.properties)) {
    // Already on the header line, as the thing being created or removed.
    if (name === "Name") continue;
    lines.push(`${pad}${name} = ${formatValue(value)}`);
  }

  for (const [name, value] of sorted(node.attributes)) {
    lines.push(`${pad}Attributes.${name} = ${formatValue(value)}`);
  }

  if (node.tags.length > 0) {
    lines.push(`${pad}Tags = { ${[...node.tags].sort().map(quote).join(", ")} }`);
  }

  if (node.source !== null) {
    lines.push(`${pad}Source = [[`);
    for (const line of node.source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
      lines.push(`${pad}${line}`);
    }
    lines.push(`${pad}]]`);
  } else if (node.sourceOmitted) {
    lines.push(`${pad}-- source too large to show`);
  }

  for (const child of node.children) {
    lines.push("");
    lines.push(renderSnapshot(child, depth + 1));
  }

  if (node.omitted > 0) {
    lines.push(`${pad}\t-- ${node.omitted} more child${node.omitted === 1 ? "" : "ren"} not shown`);
  }

  return lines.join("\n");
}

function sorted(values: Record<string, RbxValue>): Array<[string, RbxValue]> {
  // Roblox hands back a Lua table, whose key order is whatever the hash gave —
  // so the order has to be imposed here or the same instance renders differently
  // every time it is read.
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}

function quote(value: string): string {
  return JSON.stringify(value);
}
