/**
 * Studio output buffer. Cursors are what make it useful to an agent: mark
 * before a change, act, then read only what appeared since.
 */
import type { OutputEntry, StudioRealm } from "@luumen/code-protocol";

const MAX_ENTRIES = 5_000;

export interface RawOutputEntry {
  timestamp?: number;
  type?: string;
  message?: string;
  source?: string | null;
  stack?: string | null;
  realm?: string;
}

export interface OutputQuery {
  since?: string;
  limit?: number;
  types?: Array<OutputEntry["type"]>;
  contains?: string;
}

const TYPES: ReadonlySet<string> = new Set(["output", "info", "warning", "error"]);

export class OutputBuffer {
  private readonly entries: OutputEntry[] = [];
  private sequence = 0;

  /** Cursor representing "everything up to now". */
  mark(): string {
    return String(this.sequence);
  }

  append(raw: RawOutputEntry[]): OutputEntry[] {
    const added: OutputEntry[] = [];

    for (const item of raw) {
      this.sequence += 1;

      const entry: OutputEntry = {
        cursor: String(this.sequence),
        timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
        type: TYPES.has(item.type ?? "") ? (item.type as OutputEntry["type"]) : "output",
        message: typeof item.message === "string" ? item.message : String(item.message ?? ""),
        source: item.source ?? null,
        stack: item.stack ?? null,
        realm: (item.realm as StudioRealm) ?? "unknown",
      };

      this.entries.push(entry);
      added.push(entry);
    }

    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    return added;
  }

  query(options: OutputQuery = {}): { entries: OutputEntry[]; cursor: string; truncated: boolean } {
    const since = options.since !== undefined ? Number.parseInt(options.since, 10) : Number.NaN;
    const limit = options.limit ?? 100;
    const needle = options.contains?.toLowerCase();

    let matched = this.entries;

    if (Number.isFinite(since)) {
      matched = matched.filter((entry) => Number.parseInt(entry.cursor, 10) > since);
    }

    if (options.types && options.types.length > 0) {
      const wanted = new Set(options.types);
      matched = matched.filter((entry) => wanted.has(entry.type));
    }

    if (needle) {
      matched = matched.filter((entry) => entry.message.toLowerCase().includes(needle));
    }

    // The newest matters most, but reads chronologically: take the tail, in order.
    const truncated = matched.length > limit;
    const page = truncated ? matched.slice(matched.length - limit) : matched;

    return { entries: page, cursor: this.mark(), truncated };
  }

  clear(): number {
    const removed = this.entries.length;
    this.entries.length = 0;
    return removed;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** One buffer per Studio session; output from another place is never mixed in. */
export class OutputStore {
  private readonly buffers = new Map<string, OutputBuffer>();

  for(sessionId: string): OutputBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new OutputBuffer();
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  drop(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
