/**
 * A change, written out as the two versions of a file. A DataModel change is
 * not text and a diff needs text, so the instance is rendered as Luau on both
 * sides of the write and the pair handed to `@pierre/diffs`. Nothing here
 * compares anything.
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

/** Lines added and removed. */
export interface ChangeStats {
  added: number;
  removed: number;
}

/**
 * What a row calls a change: a thing, and which part of it moved.
 * `record.summary` is the plugin's sentence, for the places that want one.
 */
export interface ChangeLabel {
  /** The instance, or the script file. */
  name: string;
  /** Which part of it changed: property names, a class, a tag. */
  detail: string | null;
}

/**
 * Luau, always — the synthesised documents are property assignments, which is
 * Luau, and the highlighter is what names them.
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
      // Both sides carry every tag the operation touched, so unchanged ones sit
      // in the diff as context.
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
 * Records that describe the same document, and can therefore be read as one.
 * `create` and `source` both act on the file; `rename` acts on a line of Luau
 * naming the instance. Records merge within a family and never across one.
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
 * Changes, as the changes they add up to: the first record's before against the
 * last record's after. Grouped by instance rather than by adjacency, so a turn
 * that edits A, then B, then A again made two changes.
 *
 * Revert state is part of the key. Put one record of a bundle back and the row
 * splits — a cumulative diff of a half-reverted run describes no real place.
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
 * Which kind names the bundle. Created then edited is a create; created then
 * deleted is a delete. The outcome wins.
 */
function dominant(current: ChangeRecord["kind"], next: ChangeRecord["kind"]): ChangeRecord["kind"] {
  if (current === "delete" || next === "delete") return "delete";
  if (current === "create" || next === "create") return "create";
  return next;
}

/**
 * A bundle from records named explicitly, for the viewer. The row already
 * decided what belongs together; re-deriving it would re-split the run the
 * moment one record was put back.
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
 * One entry per name: where it started, and where it ended up. `Anchored` set
 * twice in a turn is one property with one before and one after.
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
 * What the row calls a bundle. Built from the merged data, so a turn that set
 * `Anchored` and then `CanCollide` reads as both.
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
      // Roblox's own sigil in the Properties pane; without it "Owner" reads as
      // a property.
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
 * Beyond this, the counts come from the line totals rather than a diff — a turn
 * that rewrote a dozen huge files would otherwise diff them all on mount.
 */
const MAX_DIFFED = 400_000;

/**
 * Counted once per record, then remembered. A journalled record never changes,
 * so its id is key enough, and the rows re-render on every keystroke.
 */
const COUNTED = new Map<string, ChangeStats>();

export function changeStats(record: ChangeRecord): ChangeStats {
  return remembered(record.id, () => changeDocument(record));
}

/**
 * The counts for the merged change, which are not the sum of the parts. A line
 * written by a create and rewritten by an edit is one added line.
 */
export function bundleStats(bundle: ChangeBundle): ChangeStats {
  return remembered(bundle.records.map((record) => record.id).join("|"), () => bundleDocument(bundle));
}

function remembered(key: string, build: () => ChangeDocument | null): ChangeStats {
  const cached = COUNTED.get(key);
  if (cached) return cached;

  const stats = count(build());
  // A guard against a session that never ends. The next render refills it with
  // the handful of rows on screen.
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
    // A count the library could not produce is not worth failing a row over.
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
 * The whole instance, as the Luau that would build it. Children are nested by
 * indentation — the shape of the tree is half of what a deleted Model was.
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
  // Roblox hands back a Lua table, whose key order is whatever the hash gave;
  // unsorted, the same instance renders differently every read.
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}

function quote(value: string): string {
  return JSON.stringify(value);
}
