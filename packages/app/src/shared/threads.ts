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
  /** Roblox place id. 0 for a place that has never been saved or published. */
  placeId: number;
  name: string;
  lastUsedAt: number;
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

/** Groups threads under their project, most recently used first. */
export function groupThreads(index: ThreadIndex): Array<{ project: Project; threads: ThreadSummary[] }> {
  const byProject = new Map<string, ThreadSummary[]>();

  for (const thread of index.threads) {
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
