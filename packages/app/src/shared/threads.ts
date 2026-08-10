/**
 * Projects and threads. Spec section 45.
 *
 * A project is a folder the agent works in. A thread is one durable
 * conversation inside it. Both live on disk so closing the app does not throw
 * away the work, and each thread remembers the coding agent's own session id so
 * a reopened conversation can genuinely be resumed rather than faked.
 */
import type { AgentId, TranscriptEntry } from "./agent.js";

/**
 * A place is the unit of work, not a folder.
 *
 * Luu Code is about a Roblox experience: the same place can be opened from
 * different directories, and a folder may hold none. Grouping by place means a
 * conversation is always filed against the game it was about, and there is no
 * "unknown project" bucket for chats started while Studio was disconnected —
 * those are not allowed to start at all.
 */
export interface Project {
  id: string;
  /**
   * The plugin's stable identifier for the game, or null when Studio had none
   * to give. Grouping used to fall back to the place name, which quietly filed
   * two different places that happened to share one under the same heading.
   */
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
 * A project's identity, including ones stored before the plugin sent one.
 *
 * An older record carries only a place id, and that is exactly what the plugin
 * would report for the same place today, so it is reconstructed rather than
 * throwing the grouping away on upgrade.
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
  /**
   * Done with, but not thrown away.
   *
   * The sidebar fills up with conversations that are finished rather than
   * wrong, and deleting them is the only thing worse than scrolling past them —
   * a transcript is the record of what was done to the place. Archiving moves
   * one out of the way and keeps it readable.
   */
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
}

export interface ThreadIndex {
  projects: Project[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
}

/**
 * Groups threads under their project, most recently used first.
 *
 * Archived threads are left out entirely: they have their own place at the
 * bottom of the sidebar, and a project whose every thread is archived should
 * not keep a heading in the live list.
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

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * First line of the opening message, which is what the user will recognise the
 * conversation by. Titles are only generated from what the user actually typed;
 * inventing one from the agent's reply would make the list unreliable.
 */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const trimmed = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return trimmed.length > 0 ? trimmed : "New chat";
}
