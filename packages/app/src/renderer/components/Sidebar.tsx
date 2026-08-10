/**
 * Conversation history: projects and their threads. Spec section 45.
 *
 * A project is the folder the agent runs in; threads are the durable
 * conversations inside it. Everything here is on disk, so closing the app does
 * not lose the work, and reopening a thread resumes the coding agent's own
 * session where it can.
 */
import * as React from "react";
import { ChevronRight, Folder, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Settings, Trash2 } from "lucide-react";
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
import type { Harness } from "@/state";
import { groupThreads, relativeTime } from "../../shared/threads.js";
import type { ThreadSummary } from "../../shared/threads.js";

export function Sidebar({
  harness,
  onSearch,
  settingsOpen,
  onToggleSettings,
}: {
  harness: Harness;
  onSearch: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
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
          onClick={() => void harness.newThread()}
        >
          <Plus />
          New chat
        </Button>

        {/* Opens the palette rather than filtering in place: searching is a
            thing you do to the whole app, not just to this list. */}
        <button
          onClick={onSearch}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-mono text-[9.5px] text-muted-foreground/70">⌘K</kbd>
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-2 pb-3">
          {drafting && groups.length > 0 && (
            <p className="px-1.5 pt-1 text-[11px] leading-relaxed text-muted-foreground">
              New chat — it lands here when you send.
            </p>
          )}

          {groups.length === 0 && (
            <p className="px-1.5 pt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              No chats yet. Ask for a change to start one.
            </p>
          )}

          {groups.map(({ project, threads }) => {
            const isCollapsed = collapsed.has(project.id);

            return (
              <section key={project.id} className="flex flex-col gap-0.5">
                <button
                  onClick={() => toggle(project.id)}
                  className="flex items-center gap-1.5 px-1.5 py-1 text-left text-[11px] font-semibold tracking-[0.02em] text-muted-foreground transition-colors hover:text-foreground"
                  title={project.placeId > 0 ? `Place ${project.placeId}` : "Unsaved place"}
                >
                  <ChevronRight className={cn("size-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")} />
                  <Folder className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] font-normal text-muted-foreground/60">{threads.length}</span>
                </button>

                {!isCollapsed &&
                  threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={harness.activeThreadId === thread.id}
                      renaming={renaming === thread.id}
                      onOpen={() => void harness.openThread(thread.id)}
                      onStartRename={() => setRenaming(thread.id)}
                      onRename={(title) => {
                        setRenaming(null);
                        if (title !== thread.title) void harness.renameThread(thread.id, title);
                      }}
                      onDelete={() => void harness.deleteThread(thread.id)}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      </ScrollArea>

      {/* Settings belongs at the bottom of the sidebar, out of the way of the
          conversation but always reachable. */}
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <button
          onClick={onToggleSettings}
          data-active={settingsOpen}
          className="row flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]"
        >
          <Settings className="size-3.5 shrink-0 text-muted-foreground" />
          Settings
        </button>
      </div>
    </aside>
  );
}

function ThreadRow({
  thread,
  active,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onDelete,
}: {
  thread: ThreadSummary;
  active: boolean;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
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
        className="mx-0.5 h-7 rounded-md border border-primary/50 bg-background px-2 text-[12px] outline-none"
        style={{ userSelect: "text", cursor: "auto" }}
      />
    );
  }

  return (
    <div className="row group flex items-center gap-1.5 pr-0.5 pl-2" data-active={active}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 py-[7px] text-left">
        <MessageSquare className={cn("size-3 shrink-0", active ? "text-primary" : "text-muted-foreground/60")} />
        <span className={cn("min-w-0 flex-1 truncate text-[12px]", active && "font-medium")}>{thread.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60 group-hover:hidden">
          {relativeTime(thread.updatedAt)}
        </span>
      </button>

      <DropdownMenu>
        <Hint label="Chat options">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
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
          <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
