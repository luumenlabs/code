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
import type { AgentId, TranscriptEntry } from "../shared/agent.js";
import type { Project, Thread, ThreadIndex, ThreadSummary } from "../shared/threads.js";
import { titleFrom } from "../shared/threads.js";

const FLUSH_DELAY_MS = 400;
/** Guards against a runaway agent writing an unbounded transcript. */
const MAX_ITEMS = 4_000;

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
   * Identity is the place, not the folder: an unsaved place has no id, so it is
   * keyed by name instead, and a published place opened from a different
   * directory still lands in the same group.
   */
  project(place: { placeId: number; name: string }): Project {
    const existing = this.projects.find((entry) =>
      place.placeId > 0 ? entry.placeId === place.placeId : entry.placeId === 0 && entry.name === place.name,
    );

    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.name = place.name;
      this.markIndexDirty();
      return existing;
    }

    const project: Project = {
      id: `p_${randomUUID().slice(0, 8)}`,
      placeId: place.placeId,
      name: place.name,
      lastUsedAt: Date.now(),
    };

    this.projects.push(project);
    this.markIndexDirty();
    return project;
  }

  create(
    place: { placeId: number; name: string },
    agent: AgentId | null,
    modelSelection: Thread["modelSelection"],
  ): Thread {
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
