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
import type { ChangeRecord, InstanceSnapshot, RbxValue, ValueChange } from "@luumen/code-protocol";
import { formatValue } from "@luumen/code-protocol";

export interface ChangeDocument {
  /** Shown as the filename in the diff header. */
  name: string;
  /** Null means the file did not exist on that side — a create, or a delete. */
  before: string | null;
  after: string | null;
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
