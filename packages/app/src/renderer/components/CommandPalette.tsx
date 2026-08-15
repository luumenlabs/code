/**
 * ⌘K command palette. One field over actions and every past conversation:
 * arrows move, Enter selects, Escape closes.
 */
import * as React from "react";
import { CirclePlay, MessageSquare, Plus, ScrollText, Search, Settings } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";
import { groupThreads, relativeTime } from "../../shared/threads.js";

interface Command {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon: React.ElementType;
  group: "Actions" | "Recent chats";
  run: () => void;
  disabled?: boolean;
}

export function CommandPalette({
  harness,
  open,
  onOpenChange,
  onOpenSettings,
  onExitSettings,
}: {
  harness: Harness;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  /** Anything that lands the user in a chat closes settings on the way. */
  onExitSettings: () => void;
}): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const snapshot = harness.snapshot;
  const place = snapshot?.status.sessions.find((entry) => entry.active) ?? snapshot?.status.sessions[0] ?? null;
  const running = place?.run.running ?? false;

  const commands = React.useMemo<Command[]>(() => {
    const close = (action: () => void) => () => {
      onOpenChange(false);
      action();
    };

    const actions: Command[] = [
      {
        id: "new-thread",
        label: place ? `New chat in ${place.place.name}` : "New chat",
        hint: place ? undefined : "Connect Studio first",
        shortcut: "Ctrl+N",
        icon: Plus,
        group: "Actions",
        disabled: !place,
        run: close(() => {
          onExitSettings();
          void harness.newThread();
        }),
      },
      {
        id: "playtest",
        label: running ? "Stop the playtest" : "Start a playtest",
        icon: CirclePlay,
        group: "Actions",
        disabled: !place,
        run: close(() => void harness.run(running ? "run.stop" : "run.start", running ? {} : { mode: "play" })),
      },
      {
        id: "clear-output",
        label: "Clear Studio output",
        icon: ScrollText,
        group: "Actions",
        run: close(() => harness.clearOutput()),
      },
      {
        id: "settings",
        label: "Open settings",
        icon: Settings,
        group: "Actions",
        run: close(onOpenSettings),
      },
    ];

    const threads = harness.threads
      ? groupThreads(harness.threads).flatMap((group) =>
          group.threads.map<Command>((thread) => ({
            id: thread.id,
            label: thread.title,
            hint: `${group.project.name} · ${relativeTime(thread.updatedAt)}`,
            icon: MessageSquare,
            group: "Recent chats",
            run: close(() => {
              onExitSettings();
              void harness.openThread(thread.id);
            }),
          })),
        )
      : [];

    return [...actions, ...threads];
  }, [harness, onExitSettings, onOpenChange, onOpenSettings, place, running]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle.length === 0 ? commands : commands.filter((command) =>
      `${command.label} ${command.hint ?? ""}`.toLowerCase().includes(needle),
    );
    return matching.filter((command) => !command.disabled || needle.length === 0);
  }, [commands, query]);

  React.useEffect(() => setIndex(0), [query, open]);

  // Keep the highlighted row in view while arrowing through a long list.
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[index];
      if (command && !command.disabled) command.run();
    }
  };

  let lastGroup = "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] max-w-[600px] translate-y-0 overflow-hidden p-0" onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Search commands and chats</DialogTitle>

        <div className="relative border-b">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands and chats…"
            spellCheck={false}
            className="h-13 w-full bg-transparent pr-3 pl-10 text-[15px] outline-none placeholder:text-muted-foreground"
            style={{ userSelect: "text", cursor: "auto" }}
          />
        </div>

        <div ref={listRef} className="max-h-[420px] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-2.5 py-6 text-center text-[13.5px] text-muted-foreground">No matches.</p>
          )}

          {filtered.map((command, position) => {
            const Icon = command.icon;
            const header = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;

            return (
              <React.Fragment key={command.id}>
                {header && <div className="eyebrow px-2.5 pt-3 pb-1.5">{header}</div>}

                <button
                  data-selected={position === index}
                  onMouseMove={() => setIndex(position)}
                  onClick={() => !command.disabled && command.run()}
                  className={cn(
                    "row flex w-full items-center gap-2.5 px-2.5 py-2 text-left",
                    command.disabled && "opacity-50",
                  )}
                  {...(position === index ? { "data-active": true } : {})}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{command.label}</span>
                  {command.hint && (
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">{command.hint}</span>
                  )}
                  {command.shortcut && (
                    <kbd className="shrink-0 rounded border px-1 py-px font-mono text-[10.5px] text-muted-foreground">
                      {command.shortcut}
                    </kbd>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t px-3 py-2 text-[11.5px] text-muted-foreground">
          <Legend keys="↑ ↓" label="Navigate" />
          <Legend keys="Enter" label="Select" />
          <Legend keys="Esc" label="Close" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Legend({ keys, label }: { keys: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border px-1 py-px font-mono text-[10.5px]">{keys}</kbd>
      {label}
    </span>
  );
}
