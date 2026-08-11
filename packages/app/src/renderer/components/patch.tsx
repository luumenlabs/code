/**
 * Every kind of change, rendered as one patch.
 *
 * A property write, a rename, a script edit, and a whole instance appearing are
 * different events, but they are the same question — what did this line look
 * like before, and what does it look like now. So they all become the same
 * thing: lines with a `-` or a `+` in front. One reader, one set of colours, and
 * a created Model reads as its own contents rather than as "4 descendants".
 *
 * The lines are built here rather than in the plugin. Both sides of every change
 * are already in the record; sending a third, pre-rendered copy of them through
 * Studio, the server, and the event stream would cost more than the formatting
 * saves, and would freeze the layout into the wire format.
 */
import type { ChangeRecord, InstanceSnapshot, RbxValue, ValueChange } from "@luumen/code-protocol";
import { diffLines, formatValue } from "@luumen/code-protocol";

export type PatchOp = "add" | "remove" | "same" | "meta";

export interface PatchLine {
  op: PatchOp;
  text: string;
  /** Indent level. Instance contents nest; a property write does not. */
  depth: number;
  /** Line number, for source diffs only. */
  number?: number;
}

export interface Patch {
  lines: PatchLine[];
  added: number;
  removed: number;
  /** Set when the two sides were too far apart to align, or a bound was hit. */
  note: string | null;
}

export function buildPatch(record: ChangeRecord): Patch {
  const lines: PatchLine[] = [];
  let note: string | null = null;

  switch (record.kind) {
    case "source": {
      const change = record.source;
      if (!change) break;

      if (change.before === null) {
        note = record.reason ?? "No copy of the source before this edit.";
        // Still worth showing what it is now. A rewrite with nothing to compare
        // against is not nothing to look at.
        pushSource(lines, change.after, "same");
        break;
      }

      const diff = diffLines(change.before, change.after);
      if (diff.coarse) note = "Rewritten end to end";

      for (const [index, hunk] of diff.hunks.entries()) {
        if (index > 0) lines.push({ op: "meta", text: "⋯", depth: 0 });
        for (const line of hunk.lines) {
          lines.push({
            op: line.op,
            text: line.text,
            depth: 0,
            ...(line.after ?? line.before ? { number: (line.after ?? line.before) as number } : {}),
          });
        }
      }
      break;
    }

    case "create":
    case "delete": {
      const op = record.kind === "create" ? "add" : "remove";
      if (record.snapshot) {
        pushSnapshot(lines, record.snapshot, op, 0);
      } else {
        lines.push({ op, text: `${record.target.className} "${record.target.name}"`, depth: 0 });
      }

      const where = record.parentPath;
      if (where) lines.unshift({ op: "meta", text: where, depth: 0 });
      break;
    }

    case "properties":
      pushValues(lines, record.properties ?? [], "");
      break;

    case "attributes":
      pushValues(lines, record.attributes ?? [], "@");
      break;

    case "tags":
      for (const tag of record.tags?.removed ?? []) lines.push({ op: "remove", text: `#${tag}`, depth: 0 });
      for (const tag of record.tags?.added ?? []) lines.push({ op: "add", text: `#${tag}`, depth: 0 });
      break;

    case "rename":
      if (record.renamed) {
        lines.push({ op: "remove", text: `Name = ${JSON.stringify(record.renamed.before)}`, depth: 0 });
        lines.push({ op: "add", text: `Name = ${JSON.stringify(record.renamed.after)}`, depth: 0 });
      }
      break;

    case "reparent":
      if (record.moved) {
        lines.push({ op: "remove", text: `Parent = ${record.moved.before}`, depth: 0 });
        lines.push({ op: "add", text: `Parent = ${record.moved.after}`, depth: 0 });
      }
      break;
  }

  return {
    lines,
    added: lines.filter((line) => line.op === "add").length,
    removed: lines.filter((line) => line.op === "remove").length,
    note,
  };
}

/**
 * A property on both sides.
 *
 * Only the ones that actually moved. A write that set Anchored to the value it
 * already had is real — the agent did it — but it is not a diff, and a patch
 * full of identical pairs buries the two lines that matter.
 */
function pushValues(lines: PatchLine[], values: ValueChange[], prefix: string): void {
  for (const value of [...values].sort((left, right) => left.name.localeCompare(right.name))) {
    const after = formatValue(value.after);

    if (value.unreadable) {
      lines.push({ op: "remove", text: `${prefix}${value.name} = <unreadable>`, depth: 0 });
      lines.push({ op: "add", text: `${prefix}${value.name} = ${after}`, depth: 0 });
      continue;
    }

    const before = formatValue(value.before ?? null);
    if (before === after) {
      lines.push({ op: "same", text: `${prefix}${value.name} = ${after}`, depth: 0 });
      continue;
    }

    lines.push({ op: "remove", text: `${prefix}${value.name} = ${before}`, depth: 0 });
    lines.push({ op: "add", text: `${prefix}${value.name} = ${after}`, depth: 0 });
  }
}

/** An instance and everything under it, every line the same side. */
function pushSnapshot(lines: PatchLine[], node: InstanceSnapshot, op: PatchOp, depth: number): void {
  lines.push({ op, text: `${node.className} ${JSON.stringify(node.name)}`, depth });

  for (const [name, value] of sorted(node.properties)) {
    // The name is already on the line above, as the thing being added.
    if (name === "Name") continue;
    lines.push({ op, text: `${name} = ${formatValue(value)}`, depth: depth + 1 });
  }

  for (const [name, value] of sorted(node.attributes)) {
    lines.push({ op, text: `@${name} = ${formatValue(value)}`, depth: depth + 1 });
  }

  for (const tag of [...node.tags].sort()) {
    lines.push({ op, text: `#${tag}`, depth: depth + 1 });
  }

  if (node.source !== null) {
    lines.push({ op: "meta", text: "source", depth: depth + 1 });
    pushSource(lines, node.source, op, depth + 1);
  } else if (node.sourceOmitted) {
    lines.push({ op: "meta", text: "source too large to show", depth: depth + 1 });
  }

  for (const child of node.children) {
    pushSnapshot(lines, child, op, depth + 1);
  }

  if (node.omitted > 0) {
    lines.push({
      op: "meta",
      text: `${node.omitted} more child${node.omitted === 1 ? "" : "ren"} not shown`,
      depth: depth + 1,
    });
  }
}

function pushSource(lines: PatchLine[], source: string, op: PatchOp, depth = 0): void {
  const split = source.replace(/\r\n/g, "\n").split("\n");
  if (split.length > 1 && split[split.length - 1] === "") split.pop();

  for (const [index, text] of split.entries()) {
    lines.push({ op, text, depth, number: index + 1 });
  }
}

function sorted(values: Record<string, RbxValue>): Array<[string, RbxValue]> {
  // Roblox hands back a Lua table, whose key order is whatever the hash gave —
  // so the order has to be imposed here or the same instance renders differently
  // every time it is read.
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}
