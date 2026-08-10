/**
 * The side dock: Studio state and Studio output.
 *
 * Both are reference material you glance at, not part of the conversation, so
 * they sit beside it rather than on top of it. Stacking the log above the
 * composer ate the transcript and pushed the thing you are reading around every
 * time the game printed a line.
 */
import * as React from "react";
import {
  Blocks,
  Camera,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Trash2,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { CapabilityReport, OutputEntry, StudioSession } from "@luumen/code-protocol";
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

export type DockTab = "studio" | "output";

const TONE: Record<OutputEntry["type"], string> = {
  output: "text-foreground/70",
  info: "text-foreground/70",
  warning: "text-[var(--warning)]",
  error: "text-destructive",
};

/**
 * The dock, starting at its content.
 *
 * The Studio/Output switcher used to sit in a full-height row of its own, which
 * put two 56px bars on top of each other once the title bar took the dock's
 * surface — the tabs read as floating below a band of nothing. The switcher now
 * lives in the title bar's dock segment, where that space already was, and the
 * panel opens straight onto what it is showing.
 */
export function RightDock({ harness, tab }: { harness: Harness; tab: DockTab }): React.JSX.Element | null {
  const snapshot = harness.snapshot;
  if (!snapshot) return null;

  return (
    <aside className="flex h-full min-h-0 w-dock shrink-0 flex-col overflow-hidden border-l border-sidebar-border bg-sidebar">
      <div className="min-h-0 flex-1">
        {tab === "studio" ? (
          <StudioTab harness={harness} />
        ) : (
          <OutputTab entries={harness.output} onClear={harness.clearOutput} />
        )}
      </div>
    </aside>
  );
}

/**
 * The switcher, rendered by the title bar.
 *
 * Exported from here rather than written there because what the dock shows is
 * the dock's business; the title bar only lends it the row.
 */
export function DockTabs({
  tab,
  onTabChange,
  errors,
}: {
  tab: DockTab;
  onTabChange: (tab: DockTab) => void;
  errors: number;
}): React.JSX.Element {
  return (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as DockTab)}>
      <TabsList>
        <TabsTrigger value="studio">
          <Blocks className="size-3" />
          Studio
        </TabsTrigger>
        <TabsTrigger value="output">
          Output
          {errors > 0 && <span className="ml-0.5 text-destructive">{errors}</span>}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function StudioTab({ harness }: { harness: Harness }): React.JSX.Element {
  const snapshot = harness.snapshot!;
  const { status, capabilities } = snapshot;
  const session = status.sessions.find((entry) => entry.active) ?? status.sessions[0] ?? null;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-3">
        {session ? <StudioDetails session={session} harness={harness} sessions={status.sessions} /> : <StudioEmpty />}

        <Unavailable report={capabilities} />

        <Separator />

        <McpSetup command={snapshot.mcpCommand} port={snapshot.serverPort} />
      </div>
    </ScrollArea>
  );
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{session.place.name}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            Studio {session.studioVersion} · plugin {session.pluginVersion}
          </div>
        </div>

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
                <DropdownMenuItem key={entry.id} onSelect={() => void window.luuCode.selectSession(entry.id)}>
                  <Check className={cn("size-3.5", entry.active ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{entry.place.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Facts, written as facts. These were badges, which made them look like
          controls that had stopped working; nothing here is clickable. */}
      <Field label="Mode">
        {session.run.running ? (
          <span className="text-[12.5px] text-[var(--success)]">Playtest · {session.run.realm}</span>
        ) : (
          <span className="text-[12.5px]">Edit</span>
        )}
      </Field>

      <Field label="Connections">
        <span className="truncate text-[12.5px] capitalize">
          {session.endpoints.map((endpoint) => endpoint.realm).join(" · ") || "None"}
        </span>
      </Field>

      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => void harness.run("view.screenshot", { source: "studio" })}
        >
          <Camera />
          Screenshot
        </Button>
        <Hint label="Disconnect">
          <Button variant="ghost" size="icon-sm" onClick={() => void window.luuCode.disconnectSession(session.id)}>
            <Unplug />
          </Button>
        </Hint>
      </div>
    </div>
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
        Open your place in Roblox Studio and approve the code its Luu Code panel shows.
      </p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        No panel? Install the plugin from <span className="text-foreground/80">Settings → Updates</span>, then restart
        Studio.
      </p>
    </div>
  );
}

/**
 * Only the unavailable capabilities are listed, with the reason. A list of
 * things that work is noise; a list of things that do not, and why, is the
 * answer to "why did the agent just fail".
 */
function Unavailable({ report }: { report: CapabilityReport }): React.JSX.Element | null {
  const blocked = report.capabilities.filter((entry) => !entry.available && entry.reason);
  if (blocked.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        <TriangleAlert className="size-3" />
        Unavailable right now
      </div>
      {blocked.map((entry) => (
        <div key={entry.id} className="rounded-md bg-muted/40 px-2 py-1.5">
          <code className="font-mono text-[11.5px] text-foreground/80">{entry.id}</code>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{entry.reason}</p>
        </div>
      ))}
    </div>
  );
}

function McpSetup({ command, port }: { command: string; port: number }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  // Points at the MCP server that shipped with this build, run through the
  // app's own binary — so there is nothing to install and no second version.
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
        Runs on 127.0.0.1:{port}. Nothing leaves this machine.
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
      {/* Clearing lives beside the filters now that the dock has no header of
          its own — same row, same concern: what you are looking at. */}
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
