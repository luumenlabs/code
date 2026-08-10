/**
 * Conversation history: projects and their threads. Spec section 45.
 *
 * A project is the folder the agent runs in; threads are the durable
 * conversations inside it. Everything here is on disk, so closing the app does
 * not lose the work, and reopening a thread resumes the coding agent's own
 * session where it can.
 */
import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpCircle,
  ChevronRight,
  Folder,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isBusyState } from "@/state";
import type { Harness } from "@/state";
import { archivedThreads, groupThreads, projectIdentity, relativeTime } from "../../shared/threads.js";
import type { ThreadSummary } from "../../shared/threads.js";
import { updateWaiting } from "../../shared/update.js";

export function Sidebar({
  harness,
  onSearch,
  settingsOpen,
  onToggleSettings,
  onExitSettings,
  onOpenUpdates,
}: {
  harness: Harness;
  onSearch: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** Opening a chat is a request to look at the chat, not at settings. */
  onExitSettings: () => void;
  /** The update notice goes straight to the section that can act on it. */
  onOpenUpdates: () => void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [renaming, setRenaming] = React.useState<string | null>(null);

  const groups = React.useMemo(() => (harness.threads ? groupThreads(harness.threads) : []), [harness.threads]);
  const connected = (harness.snapshot?.status.sessions.length ?? 0) > 0;

  // Nothing is highlighted while a draft is open: it is not in the list yet,
  // and it will not be until the first message is sent.
  const drafting = harness.activeThreadId === null;

  const toggle = (projectId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <aside className="flex h-full min-h-0 w-sidebar shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div className="flex flex-col gap-1.5 p-2">
        {/* A conversation is filed against a place, so there is nowhere to put
            one until Studio is connected. */}
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          disabled={!connected}
          onClick={() => {
            onExitSettings();
            void harness.newThread();
          }}
        >
          <Plus />
          New chat
        </Button>

        {/* Opens the palette rather than filtering in place: searching is a
            thing you do to the whole app, not just to this list. */}
        <button
          onClick={onSearch}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-mono text-[10.5px] text-muted-foreground/70">⌘K</kbd>
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-2 pb-3">
          {drafting && groups.length > 0 && (
            <p className="px-1.5 pt-1 text-[12px] leading-relaxed text-muted-foreground">
              New chat — it lands here when you send.
            </p>
          )}

          {groups.length === 0 && (
            <p className="px-1.5 pt-2 text-[12.5px] leading-relaxed text-muted-foreground">
              No chats yet. Ask for a change to start one.
            </p>
          )}

          {groups.map(({ project, threads }) => {
            const isCollapsed = collapsed.has(project.id);

            return (
              <section key={project.id} className="flex flex-col gap-0.5">
                <button
                  onClick={() => toggle(project.id)}
                  className="flex items-center gap-1.5 px-1.5 py-1 text-left text-[12px] font-semibold tracking-[0.02em] text-muted-foreground transition-colors hover:text-foreground"
                  title={
                    project.placeId > 0
                      ? `Place ${project.placeId}`
                      : projectIdentity(project)
                        ? `Universe ${projectIdentity(project)?.replace("game:", "")}`
                        : "Places Studio could not identify — save or publish one to give it a home of its own"
                  }
                >
                  <ChevronRight className={cn("size-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")} />
                  <Folder className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-[11px] font-normal text-muted-foreground/60">{threads.length}</span>
                </button>

                {!isCollapsed &&
                  threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={harness.activeThreadId === thread.id}
                      // Chats run in parallel, so this is asked of the thread
                      // rather than of the app: a conversation still working
                      // spins here whether or not you are looking at it.
                      running={isBusyState(harness.agentStates[thread.id])}
                      renaming={renaming === thread.id}
                      onOpen={() => {
                        onExitSettings();
                        void harness.openThread(thread.id);
                      }}
                      onStartRename={() => setRenaming(thread.id)}
                      onRename={(title) => {
                        setRenaming(null);
                        if (title !== thread.title) void harness.renameThread(thread.id, title);
                      }}
                      onArchive={() => void harness.archiveThread(thread.id, true)}
                      onDelete={() => void harness.deleteThread(thread.id)}
                    />
                  ))}
              </section>
            );
          })}

          <ArchivedSection harness={harness} onExitSettings={onExitSettings} />
        </div>
      </ScrollArea>

      {/* Settings belongs at the bottom of the sidebar, out of the way of the
          conversation but always reachable. */}
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <UpdateNotice harness={harness} onOpen={onOpenUpdates} />

        <button
          onClick={onToggleSettings}
          data-active={settingsOpen}
          className="row flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px]"
        >
          <Settings className="size-3.5 shrink-0 text-muted-foreground" />
          Settings
        </button>
      </div>
    </aside>
  );
}

/**
 * Sits above Settings when there is a newer build.
 *
 * A version behind is not an error and never interrupts what the user is doing,
 * so it is a quiet row in the one place they already look for app-level things
 * — and it opens straight onto the button that acts on it.
 */
function UpdateNotice({ harness, onOpen }: { harness: Harness; onOpen: () => void }): React.JSX.Element | null {
  const update = harness.versions?.update;
  if (!update || !updateWaiting(update)) return null;

  const label =
    update.state === "ready"
      ? "Restart to update"
      : update.state === "downloading"
        ? `Downloading… ${update.percent}%`
        : `Update to ${update.availableVersion}`;

  return (
    <button
      onClick={onOpen}
      className={cn(
        "mb-1 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12.5px] transition-colors",
        update.state === "ready"
          ? "border-[var(--success)]/35 bg-[var(--success)]/10 text-[var(--success)] hover:bg-[var(--success)]/15"
          : "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15",
      )}
    >
      {update.state === "downloading" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <ArrowUpCircle className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {update.channel === "nightly" && <span className="shrink-0 text-[10.5px] opacity-70">nightly</span>}
    </button>
  );
}

/**
 * Archived conversations, folded away and rendered small.
 *
 * The point of archiving is to get something out of your eyeline without
 * losing it, so these are deliberately quieter than a live thread: one line,
 * dimmed, no project heading. Opening one still works exactly as before.
 */
function ArchivedSection({
  harness,
  onExitSettings,
}: {
  harness: Harness;
  onExitSettings: () => void;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const archived = React.useMemo(
    () => (harness.threads ? archivedThreads(harness.threads) : []),
    [harness.threads],
  );

  if (archived.length === 0) return null;

  return (
    <section className="flex flex-col gap-0.5">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 px-1.5 py-1 text-left text-[12px] font-semibold tracking-[0.02em] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Archive className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Archived</span>
        <span className="shrink-0 text-[11px] font-normal text-muted-foreground/60">{archived.length}</span>
      </button>

      {open &&
        archived.map((thread) => (
          <div key={thread.id} className="row group flex items-center gap-1.5 pr-0.5 pl-2" data-active={harness.activeThreadId === thread.id}>
            <button
              onClick={() => {
                onExitSettings();
                void harness.openThread(thread.id);
              }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
            >
              <MessageSquare className="size-3 shrink-0 text-muted-foreground/40" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{thread.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/50">{relativeTime(thread.updatedAt)}</span>
            </button>

            <Hint label="Bring this chat back">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void harness.archiveThread(thread.id, false)}
                className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              >
                <ArchiveRestore />
              </Button>
            </Hint>
          </div>
        ))}
    </section>
  );
}

function ThreadRow({
  thread,
  active,
  running,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onArchive,
  onDelete,
}: {
  thread: ThreadSummary;
  active: boolean;
  running: boolean;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(thread.title);
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!renaming) return;
    setDraft(thread.title);
    // Select the whole title so typing replaces it.
    requestAnimationFrame(() => input.current?.select());
  }, [renaming, thread.title]);

  if (renaming) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onRename(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onRename(draft);
          if (event.key === "Escape") onRename(thread.title);
        }}
        autoFocus
        className="mx-0.5 h-7 rounded-md border border-primary/50 bg-background px-2 text-[13px] outline-none"
        style={{ userSelect: "text", cursor: "auto" }}
      />
    );
  }

  return (
    // Two lines rather than one. A title at 12px squeezed between a timestamp
    // and a menu was legible but not scannable, and the sidebar is how you find
    // a conversation from last week.
    <div className="row group flex items-start gap-1.5 py-1.5 pr-0.5 pl-2" data-active={active}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex w-full items-center gap-2">
          {running ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          ) : (
            <MessageSquare className={cn("size-3 shrink-0", active ? "text-primary" : "text-muted-foreground/60")} />
          )}
          <span className={cn("min-w-0 flex-1 truncate text-[14px] leading-snug", active && "font-medium")}>
            {thread.title}
          </span>
        </span>

        <span className="flex w-full items-center gap-1.5 pl-5 text-[11.5px] text-muted-foreground/70">
          {running ? (
            <span className="text-primary">Working…</span>
          ) : (
            <>
              <span>{relativeTime(thread.updatedAt)}</span>
              {thread.messageCount > 0 && (
                <>
                  <span className="opacity-50">·</span>
                  <span>
                    {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </>
          )}
        </span>
      </button>

      {/* One click, on the row you are already pointing at — the menu still has
          it, but tidying up a finished chat should not cost two clicks. */}
      <Hint label="Archive this chat">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onArchive}
          className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Archive />
        </Button>
      </Hint>

      <DropdownMenu>
        <Hint label="Chat options">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
        </Hint>

        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onSelect={() => setTimeout(onStartRename, 0)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onArchive}>
            <Archive />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
