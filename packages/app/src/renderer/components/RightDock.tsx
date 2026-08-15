/**
 * The side dock: Studio state and Studio output. Reference material you glance
 * at, so it sits beside the conversation rather than over it.
 */
import * as React from "react";
import {
  Blocks,
  Check,
  ChevronDown,
  Copy,
  GitCompareArrows,
  KeyRound,
  ScrollText,
  Trash2,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { CapabilityReport, OutputEntry, StudioSession } from "@luumen/code-protocol";
import { isPending } from "@luumen/code-protocol";
import { ChangesTab } from "@/components/Changes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator, Tabs, TabsList, TabsTrigger } from "@/components/ui/misc";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export type DockTab = "studio" | "changes" | "output";

const TONE: Record<OutputEntry["type"], string> = {
  output: "text-foreground/70",
  info: "text-foreground/70",
  warning: "text-[var(--warning)]",
  error: "text-destructive",
};

/**
 * The dock, opening straight onto its content. The tab switcher runs along the
 * bottom, beside the composer, so nothing above it moves when the dock opens.
 */
export function RightDock({
  harness,
  width,
  tab,
  onTabChange,
}: {
  harness: Harness;
  /** Driven by the drag handle beside it; the border lives on that. */
  width: number;
  tab: DockTab;
  onTabChange: (tab: DockTab) => void;
}): React.JSX.Element | null {
  const snapshot = harness.snapshot;
  if (!snapshot) return null;

  const errors = harness.output.filter((entry) => entry.type === "error").length;
  const standing = harness.changes.filter(isPending).length;

  return (
    <aside style={{ width }} className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-sidebar">
      <div className="min-h-0 flex-1">
        {tab === "studio" ? (
          <StudioTab harness={harness} />
        ) : tab === "changes" ? (
          <ChangesTab harness={harness} />
        ) : (
          <OutputTab entries={harness.output} onClear={harness.clearOutput} />
        )}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as DockTab)}>
          {/* Full width, thirds: along the foot of a panel this reads as a
              switch rather than as a control for whatever is above it. */}
          <TabsList className="flex w-full">
            <TabsTrigger value="studio" className="min-w-0 flex-1 justify-center">
              <Blocks className="size-3" />
              Studio
            </TabsTrigger>
            <TabsTrigger value="changes" className="min-w-0 flex-1 justify-center">
              <GitCompareArrows className="size-3" />
              Changes
              {standing > 0 && <span className="ml-0.5 tabular-nums">{standing}</span>}
            </TabsTrigger>
            <TabsTrigger value="output" className="min-w-0 flex-1 justify-center">
              {/* The same icon the transcript gives an Output line. */}
              <ScrollText className="size-3" />
              Output
              {errors > 0 && <span className="ml-0.5 text-destructive tabular-nums">{errors}</span>}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </aside>
  );
}

function StudioTab({ harness }: { harness: Harness }): React.JSX.Element {
  const snapshot = harness.snapshot!;
  const { status, capabilities } = snapshot;

  // The window the open chat is working in, which is not necessarily the
  // default — another chat may be running in a different place.
  const chatSessionId = harness.activeThreadId ? status.chats[harness.activeThreadId] : undefined;
  const session =
    status.sessions.find((entry) => entry.id === chatSessionId) ??
    status.sessions.find((entry) => entry.active) ??
    status.sessions[0] ??
    null;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-3">
        {session ? (
          <StudioDetails session={session} harness={harness} sessions={status.sessions} />
        ) : (
          <StudioEmpty />
        )}

        <Unavailable report={capabilities} />

        <Separator />

        <McpSetup command={snapshot.mcpCommand} port={snapshot.serverPort} />
      </div>
    </ScrollArea>
  );
}

/**
 * What the app knows this place by, as opposed to what it calls it — the same
 * rule the sidebar groups on. Names are never part of it.
 */
function identityOf(place: StudioSession["place"]): string | null {
  if (place.identity) return place.identity;
  if (place.placeId > 0) return `place:${place.placeId}`;
  return null;
}

function StudioDetails({
  session,
  sessions,
  harness,
}: {
  session: StudioSession;
  sessions: StudioSession[];
  harness: Harness;
}): React.JSX.Element {
  const place = session.place;
  const identity = identityOf(place);
  // No plugin API exposes the filename Studio's tab shows, so this is game.Name
  // and may not match it.
  const localName = place.nameSource === "datamodel" && place.placeId === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {localName ? (
              <Hint label="Publish the place or set game.Name to change this.">
                <span className="truncate text-[14px] font-medium">{place.name}</span>
              </Hint>
            ) : (
              <span className="truncate text-[14px] font-medium">{place.name}</span>
            )}
            {place.unsaved && <Badge variant="outline">unpublished</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            Studio {session.studioVersion} · plugin {session.pluginVersion}
          </div>
        </div>

        <Hint label="Disconnect">
          <Button variant="ghost" size="icon-sm" onClick={() => void window.luuCode.disconnectSession(session.id)}>
            <Unplug />
          </Button>
        </Hint>

        {sessions.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Studio windows</DropdownMenuLabel>
              {sessions.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => void window.luuCode.selectSession(entry.id, harness.activeThreadId ?? undefined)}
                >
                  {/* Checked against this chat's window, not the default. */}
                  <Check className={cn("size-3.5", entry.id === session.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{entry.place.name}</span>
                  {/* Two windows on one place are two entries with one name;
                      the mode is usually what tells them apart. */}
                  <span className="ml-auto pl-2 text-[11.5px] text-muted-foreground">
                    {entry.run.running ? "Playtest" : "Edit"}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Not badges: nothing on these rows is clickable. */}
      <Field label="Mode">
        {session.run.running ? (
          <span className="text-[12.5px] text-[var(--success)]">Playtest · {session.run.realm}</span>
        ) : (
          <span className="text-[12.5px]">Edit</span>
        )}
      </Field>

      {/* The id, since the name is neither reliable nor unique. */}
      {place.placeId > 0 && (
        <Field label="Place">
          <CopyableId value={String(place.placeId)} />
        </Field>
      )}

      {place.gameId > 0 && (
        <Field label="Universe">
          <CopyableId value={String(place.gameId)} />
        </Field>
      )}

      {place.creatorId !== undefined && place.creatorId > 0 && (
        <Field label="Owner">
          <span className="truncate text-[12.5px] text-muted-foreground">
            {place.creatorType ?? "User"} {place.creatorId}
          </span>
        </Field>
      )}

      {/* One connection is always the realm Mode just named. */}
      {session.endpoints.length !== 1 && (
        <Field label="Connections">
          <span className="truncate text-[12.5px] capitalize">
            {session.endpoints.map((endpoint) => endpoint.realm).join(" · ") || "None"}
          </span>
        </Field>
      )}

      {!identity && (
        <p className="flex items-center gap-1.5 text-[12px] text-[var(--warning)]">
          <TriangleAlert className="size-3 shrink-0" />
          Chats are filed under Unknown until this place is published.
        </p>
      )}

    </div>
  );
}

/** An id, and the one thing anyone does with one. */
function CopyableId({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={`Copy ${value}`}
      className="group flex min-w-0 items-center gap-1.5 rounded font-mono text-[12px] tabular-nums transition-colors hover:text-foreground"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-[var(--success)]" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground/45 group-hover:text-muted-foreground" />
      )}
    </button>
  );
}

function StudioEmpty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3">
      <Badge variant="warning">
        <Unplug className="size-3" />
        Not connected
      </Badge>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Open your place in Roblox Studio. The plugin connects on its own.
      </p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        No panel? Install the plugin from <span className="text-foreground/80">Settings → Updates</span>, then restart
        Studio.
      </p>
    </div>
  );
}

/**
 * What does not work, named. The reasons are written for an agent and run to a
 * paragraph each, so they hang off the row rather than filling the panel.
 */
function Unavailable({ report }: { report: CapabilityReport }): React.JSX.Element | null {
  const blocked = report.capabilities.filter((entry) => !entry.available && entry.reason);
  if (blocked.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        <TriangleAlert className="size-3" />
        Unavailable right now
      </div>
      <div className="flex flex-wrap gap-1">
        {blocked.map((entry) => (
          <Hint key={entry.id} label={entry.reason} side="left">
            <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">
              {entry.id}
            </code>
          </Hint>
        ))}
      </div>
    </div>
  );
}

function McpSetup({ command, port }: { command: string; port: number }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  // The MCP server that shipped with this build, run through the app's own
  // binary, so there is nothing to install.
  const snippet = `claude mcp add luu-code -e ELECTRON_RUN_AS_NODE=1 -- ${command}`;

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        Use from your terminal
      </div>
      <div className="flex items-center gap-1 rounded-md border bg-background p-1.5">
        <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{snippet}</code>
        <Button variant="ghost" size="icon-sm" onClick={() => void copy()}>
          {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        </Button>
      </div>
      <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <KeyRound className="size-3" />
        127.0.0.1:{port}
      </p>
    </div>
  );
}

function OutputTab({
  entries,
  onClear,
}: {
  entries: OutputEntry[];
  onClear: () => void;
}): React.JSX.Element {
  const viewport = React.useRef<HTMLDivElement>(null);
  const [filter, setFilter] = React.useState<"all" | "error" | "warning">("all");

  const shown = React.useMemo(() => {
    const filtered = filter === "all" ? entries : entries.filter((entry) => entry.type === filter);
    return filtered.slice(-400);
  }, [entries, filter]);

  React.useEffect(() => {
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [shown]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Clearing sits beside the filters: same concern, same row. */}
      <div className="flex shrink-0 items-center gap-1 px-2.5 py-2">
        {(["all", "error", "warning"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[12px] capitalize transition-colors",
              filter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "all" ? "All" : `${value}s`}
          </button>
        ))}

        <span className="flex-1" />

        <Hint label="Clear output">
          <Button variant="ghost" size="icon-sm" onClick={onClear} className="text-muted-foreground">
            <Trash2 />
          </Button>
        </Hint>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewport}>
        <div className="flex flex-col gap-1 px-2.5 pb-3 font-mono text-[11.5px] leading-[1.6]">
          {shown.length === 0 && (
            <p className="py-2 font-sans text-[12.5px] text-muted-foreground">
              Nothing yet.
            </p>
          )}
          {shown.map((entry) => (
            <div key={entry.cursor} className="selectable">
              <div className="flex items-baseline gap-1.5">
                <span className="shrink-0 text-muted-foreground/50">{entry.realm}</span>
                {entry.source && <span className="shrink-0 text-primary/80">{entry.source}</span>}
              </div>
              <div className={cn("break-words whitespace-pre-wrap", TONE[entry.type])}>{entry.message}</div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
