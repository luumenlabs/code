/**
 * Projects and threads. A project is a Roblox place; a thread is one durable
 * conversation inside it. Both live on disk, and each thread remembers the
 * agent's own session id so a reopened conversation is genuinely resumed.
 */
import type { ChangeRecord } from "@luumen/code-protocol";
import type { AgentId, TranscriptEntry } from "./agent.js";

/**
 * A place is the unit of work, not a folder — the same place can be opened from
 * different directories. A chat cannot start while Studio is disconnected.
 */
export interface Project {
  id: string;
  /** The plugin's stable identifier for the game, or null when it had none. */
  identity: string | null;
  /** Roblox place id. 0 for a place that has never been saved or published. */
  placeId: number;
  name: string;
  lastUsedAt: number;
}

/** Where a project with no identity goes, and what its heading reads. */
export const UNKNOWN_PROJECT_NAME = "Unknown";

/** What a thread needs to know about the place it is filed against. */
export interface PlaceRef {
  identity: string | null;
  placeId: number;
  name: string;
}

/**
 * A project's identity, including records stored before the plugin sent one —
 * those carry only a place id, which is what the plugin reports today anyway.
 */
export function projectIdentity(project: Project): string | null {
  if (project.identity) return project.identity;
  return project.placeId > 0 ? `place:${project.placeId}` : null;
}

export interface ThreadSummary {
  id: string;
  /** The place this conversation belongs to. Never null: no place, no thread. */
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agent: AgentId | null;
  placeName: string | null;
  messageCount: number;
  /** Out of the sidebar's live list, still readable. */
  archived?: boolean;
}

export interface Thread extends ThreadSummary {
  /**
   * The coding agent CLI's own session id. Present means the conversation can
   * be resumed; absent means the transcript is history only.
   */
  agentSessionId: string | null;
  /** Model and options this conversation is using. */
  modelSelection: import("./models.js").ModelSelection | null;
  items: TranscriptEntry[];
  /**
   * What this conversation changed, kept for reading rather than reverting. The
   * server's journal is in memory and per Studio window, which is what a revert
   * needs; a record no longer in it renders the same and offers no Revert.
   */
  changes?: ChangeRecord[];
}

export interface ThreadIndex {
  projects: Project[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
}

/**
 * Groups threads under their project, most recently used first. Archived
 * threads are left out; they have their own list at the bottom of the sidebar.
 */
export function groupThreads(index: ThreadIndex): Array<{ project: Project; threads: ThreadSummary[] }> {
  const byProject = new Map<string, ThreadSummary[]>();

  for (const thread of index.threads) {
    if (thread.archived) continue;

    const existing = byProject.get(thread.projectId);
    if (existing) existing.push(thread);
    else byProject.set(thread.projectId, [thread]);
  }

  return index.projects
    .map((project) => ({
      project,
      threads: (byProject.get(project.id) ?? []).sort((left, right) => right.updatedAt - left.updatedAt),
    }))
    .filter((group) => group.threads.length > 0)
    .sort((left, right) => {
      const leftAt = left.threads[0]?.updatedAt ?? left.project.lastUsedAt;
      const rightAt = right.threads[0]?.updatedAt ?? right.project.lastUsedAt;
      return rightAt - leftAt;
    });
}

/** The archived ones, newest first. Their project is shown on the row instead. */
export function archivedThreads(index: ThreadIndex): ThreadSummary[] {
  return index.threads.filter((thread) => thread.archived).sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * The provider a conversation is fixed to, or null while it is still a draft.
 * No agent can pick up a session another one created, so a chat belongs to the
 * provider that started it for the whole of its life.
 */
export function lockedProvider(index: ThreadIndex | null, threadId: string | null): AgentId | null {
  if (!threadId) return null;
  return index?.threads.find((thread) => thread.id === threadId)?.agent ?? null;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** First line of the opening message. Titles come only from what was typed. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const trimmed = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return trimmed.length > 0 ? trimmed : "New chat";
}
