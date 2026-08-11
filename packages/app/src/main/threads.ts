/**
 * On-disk thread storage. Spec section 45.
 *
 * One JSON file per thread plus a small index, under the app's user data
 * directory. Files rather than a database because the whole point is that a
 * conversation survives a crash, is greppable, and can be deleted by hand.
 *
 * Writes are debounced: a busy agent produces transcript entries far faster
 * than they need to reach the disk, and rewriting the file on every token would
 * be the only expensive thing this app does.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChangeRecord, InstanceSnapshot } from "@luumen/code-protocol";
import type { AgentId, TranscriptEntry } from "../shared/agent.js";
import type { PlaceRef, Project, Thread, ThreadIndex, ThreadSummary } from "../shared/threads.js";
import { UNKNOWN_PROJECT_NAME, projectIdentity, titleFrom } from "../shared/threads.js";

const FLUSH_DELAY_MS = 400;
/** Guards against a runaway agent writing an unbounded transcript. */
const MAX_ITEMS = 4_000;

/**
 * How much of a conversation's diff history is kept, and why there are two
 * numbers rather than one.
 *
 * Records are wildly uneven. A property write is a few hundred bytes; a script
 * rewrite carries both versions of the file, and the plugin lets that reach
 * half a megabyte on each side. A count alone would let twenty script edits
 * put ten megabytes in one thread file, and a byte budget alone would let a
 * thousand tiny records pile up unnoticed. Whichever is hit first evicts from
 * the front, so what survives is always the most recent work.
 */
const MAX_CHANGES = 500;
const MAX_CHANGE_BYTES = 6 * 1024 * 1024;

export class ThreadStore {
  private readonly root: string;
  private readonly threadsDir: string;
  private projects: Project[] = [];
  private threads = new Map<string, Thread>();
  private activeThreadId: string | null = null;
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string) {
    this.root = userDataDir;
    this.threadsDir = join(userDataDir, "threads");
    this.load();
  }

  private load(): void {
    mkdirSync(this.threadsDir, { recursive: true });

    try {
      const raw = JSON.parse(readFileSync(join(this.root, "projects.json"), "utf8")) as {
        projects?: Project[];
        activeThreadId?: string | null;
      };
      this.projects = Array.isArray(raw.projects) ? raw.projects : [];
      this.activeThreadId = raw.activeThreadId ?? null;
    } catch {
      // First run.
    }

    for (const file of readdirSync(this.threadsDir)) {
      if (!file.endsWith(".json")) continue;

      try {
        const thread = JSON.parse(readFileSync(join(this.threadsDir, file), "utf8")) as Thread;
        if (thread.id) this.threads.set(thread.id, thread);
      } catch {
        // A corrupt thread must not stop the app from opening; skip it and
        // leave the file in place so it can be inspected.
      }
    }

    this.regroupByIdentity();
  }

  /**
   * Folds the stored projects onto their identity.
   *
   * Projects used to be keyed by place id *or*, when there was none, by name —
   * so two unsaved places called the same thing shared one heading and one
   * scratch directory. Reading them back through the identity rule collapses
   * every duplicate onto one record and moves the identity-less ones into the
   * Unknown bucket, repointing their threads on the way. Without the repoint,
   * a thread would name a project that no longer exists and vanish from the
   * sidebar, which is the one outcome worse than a wrong heading.
   */
  private regroupByIdentity(): void {
    if (this.projects.length === 0) return;

    const kept = new Map<string, Project>();
    const remap = new Map<string, string>();

    for (const project of this.projects) {
      const identity = projectIdentity(project);
      const key = identity ?? "";
      const existing = kept.get(key);

      if (!existing) {
        kept.set(key, {
          ...project,
          identity,
          ...(identity ? {} : { placeId: 0, name: UNKNOWN_PROJECT_NAME }),
        });
        continue;
      }

      remap.set(project.id, existing.id);
      existing.lastUsedAt = Math.max(existing.lastUsedAt, project.lastUsedAt);
    }

    this.projects = [...kept.values()];
    if (remap.size === 0) return;

    for (const thread of this.threads.values()) {
      const target = remap.get(thread.projectId);
      if (!target) continue;
      thread.projectId = target;
      this.touch(thread.id);
    }

    this.markIndexDirty();
  }

  index(): ThreadIndex {
    const summaries: ThreadSummary[] = [...this.threads.values()].map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      agent: thread.agent,
      placeName: thread.placeName,
      messageCount: thread.messageCount,
      ...(thread.archived ? { archived: true } : {}),
    }));

    return { projects: this.projects, threads: summaries, activeThreadId: this.activeThreadId };
  }

  get(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }

  active(): Thread | null {
    return this.activeThreadId ? (this.threads.get(this.activeThreadId) ?? null) : null;
  }

  /**
   * Finds or creates the project record for a Roblox place.
   *
   * Identity is the game, not the folder and not the name: a published place
   * opened from a different directory lands in the same group, and two places
   * that merely share a title do not. When the plugin has no identity to give,
   * everything goes to one Unknown bucket — an honest "we cannot tell these
   * apart" rather than a heading that claims they are the same game.
   */
  project(place: PlaceRef): Project {
    const identity = place.identity ?? null;
    const existing = this.projects.find((entry) => projectIdentity(entry) === identity);

    if (existing) {
      existing.lastUsedAt = Date.now();
      // The Unknown bucket holds more than one place, so no single place gets
      // to rename it.
      if (identity) existing.name = place.name;
      this.markIndexDirty();
      return existing;
    }

    const project: Project = {
      id: `p_${randomUUID().slice(0, 8)}`,
      identity,
      placeId: identity ? place.placeId : 0,
      name: identity ? place.name : UNKNOWN_PROJECT_NAME,
      lastUsedAt: Date.now(),
    };

    this.projects.push(project);
    this.markIndexDirty();
    return project;
  }

  /**
   * Takes a better name for a place already on file, and only that.
   *
   * The plugin resolves the published place name a moment after connecting, so
   * a heading written when the first chat was filed can be a name Roblox has
   * since corrected. Unlike `project`, this creates nothing: a place the user
   * has never had a conversation about should not gain a heading in the
   * sidebar just for being open in Studio.
   *
   * Returns whether anything moved, so the caller only pushes the index when
   * there is something to push — this runs on every session status change.
   */
  describe(place: PlaceRef): boolean {
    const identity = place.identity ?? null;
    // The Unknown bucket holds more than one place, so no single place gets to
    // rename it.
    if (!identity) return false;

    const project = this.projects.find((entry) => projectIdentity(entry) === identity);
    if (!project || project.name === place.name) return false;

    project.name = place.name;
    this.markIndexDirty();
    return true;
  }

  create(place: PlaceRef, agent: AgentId | null, modelSelection: Thread["modelSelection"]): Thread {
    const project = this.project(place);
    const now = Date.now();

    const thread: Thread = {
      id: `t_${randomUUID().slice(0, 8)}`,
      projectId: project.id,
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      agent,
      agentSessionId: null,
      modelSelection,
      placeName: place.name,
      messageCount: 0,
      items: [],
    };

    this.threads.set(thread.id, thread);
    this.activeThreadId = thread.id;
    this.touch(thread.id);
    return thread;
  }

  select(id: string): Thread | null {
    const thread = this.threads.get(id);
    if (!thread) return null;
    this.activeThreadId = id;
    this.markIndexDirty();
    return thread;
  }

  /**
   * Leaves no thread open, which is what "New chat" means.
   *
   * A conversation that was never sent is not a conversation: writing one to
   * disk and listing it in the sidebar puts an empty row in the user's history
   * every time they change their mind. The thread is created by the first
   * message instead.
   */
  clearActive(): void {
    this.activeThreadId = null;
    this.markIndexDirty();
  }

  append(id: string, item: TranscriptEntry): void {
    const thread = this.threads.get(id);
    if (!thread) return;

    thread.items.push(item);

    if (thread.items.length > MAX_ITEMS) {
      thread.items.splice(0, thread.items.length - MAX_ITEMS);
    }

    if (item.kind === "user") {
      thread.messageCount += 1;
      // The first thing the user typed is the thread's name.
      if (thread.title === "New chat") thread.title = titleFrom(item.text);
    }

    thread.updatedAt = Date.now();
    this.touch(id);
  }

  /**
   * Replaces an entry that already exists, used when a tool result arrives for
   * a call that was written earlier.
   */
  update(id: string, itemId: string, patch: Partial<TranscriptEntry>): void {
    const thread = this.threads.get(id);
    if (!thread) return;

    const index = thread.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) return;

    thread.items[index] = { ...thread.items[index], ...patch } as TranscriptEntry;
    thread.updatedAt = Date.now();
    this.touch(id);
  }

  /**
   * Keeps a copy of what the agent changed, alongside the transcript that
   * asked for it.
   *
   * Upserted by id rather than appended, because the same record comes back
   * once it has been reverted — and a stored copy still claiming to be pending
   * would put a Revert button on something already put back. Order is by when
   * the change happened, not by when it arrived: a revert notification is not
   * a reason for a record to jump to the end of the list.
   *
   * A batch that says nothing new schedules no write. The journal resends
   * records the app already holds — on a reconnect, and on every revert — and
   * rewriting a thread file to store bytes identical to the ones in it is the
   * kind of work that turns a busy agent into disk churn.
   */
  recordChanges(id: string, records: ChangeRecord[]): boolean {
    const thread = this.threads.get(id);
    if (!thread || records.length === 0) return false;

    const byId = new Map((thread.changes ?? []).map((record) => [record.id, record]));
    let moved = false;

    for (const record of records) {
      const existing = byId.get(record.id);
      if (existing && existing.revertedAt === record.revertedAt) continue;
      byId.set(record.id, record);
      moved = true;
    }

    if (!moved) return false;

    thread.changes = trimChanges([...byId.values()].sort((left, right) => left.at - right.at));
    this.touch(id);
    return true;
  }

  setMeta(
    id: string,
    patch: Partial<Pick<Thread, "agent" | "agentSessionId" | "placeName" | "title" | "modelSelection">>,
  ): void {
    const thread = this.threads.get(id);
    if (!thread) return;

    Object.assign(thread, patch);
    this.touch(id);
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    this.setMeta(id, { title: trimmed });
  }

  /**
   * Files a conversation away, or brings it back.
   *
   * `updatedAt` is deliberately left alone: archiving is not work on the
   * thread, and bumping it would shuffle the archive into a false order the
   * moment it was tidied.
   */
  setArchived(id: string, archived: boolean): void {
    const thread = this.threads.get(id);
    if (!thread || Boolean(thread.archived) === archived) return;

    thread.archived = archived;
    this.touch(id);
  }

  remove(id: string): void {
    const thread = this.threads.get(id);
    if (!thread) return;

    this.threads.delete(id);
    this.dirty.delete(id);

    try {
      rmSync(join(this.threadsDir, `${id}.json`), { force: true });
    } catch {
      // Already gone.
    }

    if (this.activeThreadId === id) {
      const next = [...this.threads.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      this.activeThreadId = next?.id ?? null;
    }

    // Drop projects that no longer have any threads.
    const used = new Set([...this.threads.values()].map((entry) => entry.projectId));
    this.projects = this.projects.filter((project) => used.has(project.id));

    this.markIndexDirty();
  }

  private touch(id: string): void {
    this.dirty.add(id);
    this.scheduleFlush();
  }

  private markIndexDirty(): void {
    this.dirty.add("__index__");
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Writes everything pending. Called on a timer and on quit. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    for (const id of this.dirty) {
      if (id === "__index__") continue;
      const thread = this.threads.get(id);
      if (thread) this.writeAtomic(join(this.threadsDir, `${id}.json`), thread);
    }

    if (this.dirty.size > 0) {
      this.writeAtomic(join(this.root, "projects.json"), {
        projects: this.projects,
        activeThreadId: this.activeThreadId,
      });
    }

    this.dirty.clear();
  }

  /**
   * Write to a temporary file and rename over the target, so a crash mid-write
   * cannot leave a half-written thread behind.
   */
  private writeAtomic(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;

    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2));
      renameSync(temporary, path);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }
}

/**
 * Drops the oldest records until the archive is within both budgets.
 *
 * Weighed rather than serialised. `JSON.stringify` on the whole archive runs on
 * every mutating operation the agent performs, and the answer is dominated by
 * the two or three text fields a record can carry anyway — script source and a
 * deleted subtree's snapshot. An estimate that is cheap and slightly generous
 * is the right shape of wrong for a budget whose only job is to stop a thread
 * file growing without bound.
 */
function trimChanges(records: ChangeRecord[]): ChangeRecord[] {
  let kept = records.length > MAX_CHANGES ? records.slice(records.length - MAX_CHANGES) : records;

  let total = 0;
  for (const record of kept) total += weigh(record);
  if (total <= MAX_CHANGE_BYTES) return kept;

  // Oldest first: the newest change is the one the user is looking at.
  let from = 0;
  while (from < kept.length - 1 && total > MAX_CHANGE_BYTES) {
    total -= weigh(kept[from]!);
    from += 1;
  }

  kept = kept.slice(from);
  return kept;
}

/** Roughly what a record costs on disk. The text is all that really counts. */
function weigh(record: ChangeRecord): number {
  // Everything a record carries that is not text: paths, names, values, ids.
  let bytes = 512;

  if (record.source) {
    bytes += (record.source.before?.length ?? 0) + record.source.after.length;
  }

  if (record.snapshot) bytes += weighSnapshot(record.snapshot);

  return bytes;
}

function weighSnapshot(node: InstanceSnapshot): number {
  // Bounded by the plugin at 120 nodes, so this cannot run away.
  let bytes = 256 + (node.source?.length ?? 0);
  for (const child of node.children) bytes += weighSnapshot(child);
  return bytes;
}
