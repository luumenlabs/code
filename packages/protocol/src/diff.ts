/**
 * Line diffing, for script sources.
 *
 * Hand-rolled rather than pulled in, because the requirement is small and
 * specific: a script is a handful of hundreds of lines, both sides are already
 * in memory, and the output is read by a human in a side panel. A general diff
 * library would bring a patch format and a merge engine this product has no use
 * for.
 *
 * The interesting case is the ordinary one — an agent changed four lines in a
 * six-hundred-line file — so the common prefix and suffix are trimmed before any
 * real work starts. What is left is usually tiny, and the quadratic table below
 * never sees the file at all.
 */

export type DiffOp = "same" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number on the left, or null for an added line. */
  before: number | null;
  /** 1-based line number on the right, or null for a removed line. */
  after: number | null;
  text: string;
}

export interface DiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  lines: DiffLine[];
}

export interface TextDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /**
   * True when the two sides were too far apart to align line by line, and the
   * result is the whole of one replaced by the whole of the other. Said out
   * loud rather than passed off as a real diff.
   */
  coarse: boolean;
}

export interface DiffOptions {
  /** Unchanged lines kept either side of a change. */
  context?: number;
  /**
   * Above this many cells of alignment work, the diff gives up and reports a
   * wholesale replacement. A full rewrite of a large script is not a diff worth
   * computing, and the user reads it as a rewrite either way.
   */
  maxCells?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // A trailing newline terminates the last line rather than starting an empty
  // one, which is what every editor shows and what keeps line numbers honest.
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countLines(text: string): number {
  return splitLines(text).length;
}

export function diffLines(before: string, after: string, options: DiffOptions = {}): TextDiff {
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;

  const left = splitLines(before);
  const right = splitLines(after);

  // Identical sources still reach here — a patch that only changed whitespace
  // Studio then normalised, for instance — and an empty hunk list says so more
  // clearly than a diff of nothing against nothing.
  if (left.length === right.length && left.every((line, index) => line === right[index])) {
    return { hunks: [], added: 0, removed: 0, coarse: false };
  }

  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;

  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const leftMiddle = left.slice(head, left.length - tail);
  const rightMiddle = right.slice(head, right.length - tail);

  const coarse = leftMiddle.length * rightMiddle.length > maxCells;
  const middle = coarse ? replaceWholesale(leftMiddle, rightMiddle, head) : align(leftMiddle, rightMiddle, head);

  const lines: DiffLine[] = [
    ...left.slice(0, head).map((text, index) => same(text, index + 1, index + 1)),
    ...middle,
    ...left.slice(left.length - tail).map((text, index) => {
      const beforeNumber = left.length - tail + index + 1;
      const afterNumber = right.length - tail + index + 1;
      return same(text, beforeNumber, afterNumber);
    }),
  ];

  return {
    hunks: toHunks(lines, context),
    added: lines.filter((line) => line.op === "add").length,
    removed: lines.filter((line) => line.op === "remove").length,
    coarse,
  };
}

/**
 * Longest common subsequence over the lines that actually differ.
 *
 * Int32Array rather than nested arrays: the table is the only allocation that
 * scales with the input, and a rewrite of a thousand-line script would otherwise
 * build a million boxed numbers to answer a question about four lines.
 */
function align(left: string[], right: string[], offset: number): DiffLine[] {
  const rows = left.length;
  const columns = right.length;

  if (rows === 0 || columns === 0) {
    return [
      ...left.map((text, index) => removed(text, offset + index + 1)),
      ...right.map((text, index) => added(text, offset + index + 1)),
    ];
  }

  const width = columns + 1;
  const table = new Int32Array((rows + 1) * width);

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        left[row] === right[column]
          ? table[(row + 1) * width + column + 1]! + 1
          : Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (left[row] === right[column]) {
      lines.push(same(left[row]!, offset + row + 1, offset + column + 1));
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
      lines.push(removed(left[row]!, offset + row + 1));
      row += 1;
    } else {
      lines.push(added(right[column]!, offset + column + 1));
      column += 1;
    }
  }

  while (row < rows) {
    lines.push(removed(left[row]!, offset + row + 1));
    row += 1;
  }

  while (column < columns) {
    lines.push(added(right[column]!, offset + column + 1));
    column += 1;
  }

  return lines;
}

function replaceWholesale(left: string[], right: string[], offset: number): DiffLine[] {
  return [
    ...left.map((text, index) => removed(text, offset + index + 1)),
    ...right.map((text, index) => added(text, offset + index + 1)),
  ];
}

/**
 * Groups changed lines into hunks with context around them.
 *
 * Runs of unchanged lines shorter than twice the context are kept whole rather
 * than split: two hunks separated by one shared line is harder to read than one
 * hunk containing it.
 */
function toHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const interesting = lines
    .map((line, index) => (line.op === "same" ? -1 : index))
    .filter((index) => index !== -1);

  if (interesting.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];

  for (const index of interesting) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];

    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range) => {
    const slice = lines.slice(range.start, range.end + 1);
    const beforeNumbers = slice.map((line) => line.before).filter((value): value is number => value !== null);
    const afterNumbers = slice.map((line) => line.after).filter((value): value is number => value !== null);

    return {
      beforeStart: beforeNumbers[0] ?? 0,
      beforeLines: beforeNumbers.length,
      afterStart: afterNumbers[0] ?? 0,
      afterLines: afterNumbers.length,
      lines: slice,
    };
  });
}

/** Unified-diff text, for the clipboard and for anything that wants one string. */
export function formatDiff(diff: TextDiff, label = "script"): string {
  if (diff.hunks.length === 0) return "";

  const out = [`--- ${label}`, `+++ ${label}`];

  for (const hunk of diff.hunks) {
    out.push(`@@ -${hunk.beforeStart},${hunk.beforeLines} +${hunk.afterStart},${hunk.afterLines} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.op === "add" ? "+" : line.op === "remove" ? "-" : " "}${line.text}`);
    }
  }

  return out.join("\n");
}

function same(text: string, before: number, after: number): DiffLine {
  return { op: "same", before, after, text };
}

function added(text: string, after: number): DiffLine {
  return { op: "add", before: null, after, text };
}

function removed(text: string, before: number): DiffLine {
  return { op: "remove", before, after: null, text };
}
