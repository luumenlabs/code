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
import { formatValue } from "@luumen/code-protocol";

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

/** True when there is a document worth opening the row for. */
export function hasDocument(record: ChangeRecord): boolean {
  const document = changeDocument(record);
  return document !== null && (document.before !== null || document.after !== null);
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
  const cached = COUNTED.get(record.id);
  if (cached) return cached;

  const stats = count(record);
  // A guard against a session that never ends, not a policy: the next render
  // pays for the handful of rows actually on screen and the map refills.
  if (COUNTED.size > 1_000) COUNTED.clear();
  COUNTED.set(record.id, stats);
  return stats;
}

function count(record: ChangeRecord): ChangeStats {
  const document = changeDocument(record);
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
