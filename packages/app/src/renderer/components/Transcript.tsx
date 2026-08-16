/**
 * The conversation, with Roblox activity shown inline. Studio operations appear
 * in Roblox language rather than as tool identifiers, and a screenshot the
 * agent captured is shown where it happened.
 */
import * as React from "react";
import {
  Blocks,
  Bot,
  Brain,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  Eye,
  FileText,
  FolderTree,
  Gamepad2,
  Globe,
  ListTodo,
  Loader2,
  MonitorPlay,
  Pencil,
  ScrollText,
  Search,
  SquareTerminal,
  Store,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ActivityEvent } from "@luumen/code-protocol";
import type { AgentState } from "../../shared/agent.js";
import { BrandMark } from "@/components/Brand";
import { TurnChanges } from "@/components/Changes";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/misc";
import { ScrollArea } from "@/components/ui/scroll-area";
import { describeTool } from "@/components/toolSummary";
import type { ToolGlyph } from "@/components/toolSummary";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/state";

/** One glyph per kind of work, so a turn can be skimmed down the left edge. */
const TOOL_ICON: Record<ToolGlyph, React.ElementType> = {
  read: FileText,
  edit: Pencil,
  shell: Terminal,
  search: Search,
  files: FolderTree,
  web: Globe,
  plan: ListTodo,
  agent: Bot,
  mcp: Blocks,
  tool: Wrench,
};

const CATEGORY: Record<ActivityEvent["category"], { label: string; icon: React.ElementType; tone: string }> = {
  inspect: { label: "Inspect", icon: Eye, tone: "text-sky-400/90" },
  edit: { label: "Edit", icon: Pencil, tone: "text-violet-400/90" },
  playtest: { label: "Playtest", icon: MonitorPlay, tone: "text-[var(--success)]" },
  output: { label: "Output", icon: ScrollText, tone: "text-muted-foreground" },
  runtime: { label: "Runtime", icon: SquareTerminal, tone: "text-amber-400/90" },
  visual: { label: "Screenshot", icon: Camera, tone: "text-[var(--warning)]" },
  input: { label: "Input", icon: Gamepad2, tone: "text-cyan-400/90" },
  assets: { label: "Store", icon: Store, tone: "text-emerald-400/90" },
};

const EXAMPLES = [
  "Fix the error when I click Buy",
  "Make the inventory UI open and close",
  "Brighten the lobby, then screenshot it",
];

/**
 * Memoised: its props are all narrow, so Studio output, status changes, and
 * version polling no longer redraw the conversation.
 */
export const Transcript = React.memo(function Transcript({
  items,
  onExample,
  showThinking,
  placeName,
  busy,
  state,
}: {
  items: TimelineItem[];
  onExample: (text: string) => void;
  showThinking: boolean;
  /** The place this chat is filed against, shown while it is still empty. */
  placeName: string | null;
  /** The agent is mid-turn, so the transcript says so rather than sitting still. */
  busy: boolean;
  state: AgentState | undefined;
}): React.JSX.Element {
  const viewport = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    // Only follow along when the user is already at the bottom.
    if (!pinned.current) return;
    const element = viewport.current;
    if (!element) return;

    /*
      Smooth only for a real jump — a sent message, a reopened thread. Streaming
      grows the column a few pixels at a time, and asking for a smooth scroll on
      every token restarts the animation before it lands, which reads as the
      view lagging behind the text rather than following it.
    */
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    element.scrollTo({ top: element.scrollHeight, behavior: distance > 240 ? "smooth" : "auto" });
    // `busy` too: the working line appearing changes the height.
  }, [items, busy]);

  const onScroll = (): void => {
    const element = viewport.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
  };

  if (items.length === 0) {
    return <EmptyState onExample={onExample} placeName={placeName} />;
  }

  const visible = showThinking ? items : items.filter((item) => item.kind !== "thinking");
  const turns = splitTurns(visible);

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportRef={viewport}
      onScrollCapture={onScroll}
      /* The conversation dissolves rather than being clipped where it runs
         under the title bar — see `.fade-under-topbar`. */
      viewportClassName="fade-under-topbar"
    >
      {/* The column width matches the composer's card. The top inset is the
          fade's own height, so a short conversation is never dimmed. */}
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-7 pt-[var(--transcript-fade)] pb-7">
        {turns.map((turn, index) => (
          <Turn
            key={turn[0]!.id}
            items={turn}
            busy={busy}
            // The turn in progress already has the live "Working for" line.
            live={busy && index === turns.length - 1}
          />
        ))}

        {busy && <Working state={state} since={turns[turns.length - 1]?.[0]?.at ?? null} />}
      </div>
    </ScrollArea>
  );
});

/**
 * One exchange: what the user asked, and everything the agent did about it.
 * A running turn is shown row by row; once it lands, the working-out folds
 * behind a single line above the answer.
 */
function Turn({ items, busy, live }: { items: TimelineItem[]; busy: boolean; live: boolean }): React.JSX.Element {
  const asked = items.filter((item) => item.kind === "user");
  const rest = items.filter((item) => item.kind !== "user");

  // The last thing the agent said is the answer; everything before it is how it
  // got there. A turn with no answer has nothing to fold behind.
  const answerAt = rest.map((item) => item.kind).lastIndexOf("assistant");
  const working = answerAt === -1 ? [] : rest.slice(0, answerAt);
  const answer = answerAt === -1 ? rest : rest.slice(answerAt);

  /* Every operation in the turn, folded or not. `TurnChanges` shows what they
     changed together underneath, outside the folds. */
  const activityIds = React.useMemo(
    () => items.filter((item) => item.kind === "activity").map((item) => item.activity.id),
    [items],
  );

  return (
    // Keyed on the turn's first entry, so this plays once when the turn arrives
    // rather than on every token that lands inside it.
    <div className="animate-rise flex flex-col gap-3">
      {asked.map((item) => (
        <Row key={item.id} item={item} busy={busy} />
      ))}

      {live || working.length === 0 ? (
        <Rows items={live ? rest : answer} busy={busy} />
      ) : (
        <>
          <WorkFold items={working} turn={items} busy={busy} />
          <Rows items={answer} busy={busy} />
        </>
      )}

      <TurnChanges activityIds={activityIds} />

      {!live && <TurnFooter items={items} />}
    </div>
  );
}

/** Rows, with neighbouring operations folded down the way a live turn does. */
function Rows({ items, busy }: { items: TimelineItem[]; busy: boolean }): React.JSX.Element {
  return (
    <>
      {groupRuns(items).map((run) =>
        run.kind === "single" ? (
          <Row key={run.item.id} item={run.item} busy={busy} />
        ) : (
          <Run key={run.items[0]!.id} items={run.items} busy={busy} />
        ),
      )}
    </>
  );
}

/**
 * "Worked for 1m 12s", and everything that took behind it. The rows inside are
 * flat rather than grouped again — they are already one click away.
 */
function WorkFold({
  items,
  turn,
  busy,
}: {
  items: TimelineItem[];
  turn: TimelineItem[];
  busy: boolean;
}): React.JSX.Element {
  const elapsed = span(turn);
  const failed = items.filter(hasFailed).length;

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span>{elapsed === null ? `${items.length} steps` : `Worked for ${duration(elapsed)}`}</span>
        {/* Never let a fold hide a failure. */}
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-2 border-l-2 border-border pl-3">
          {items.map((item) => (
            <Row key={item.id} item={item} busy={busy} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * When it finished, and the whole thing on the clipboard. A turn that is only
 * the typed message has nothing to report.
 */
function TurnFooter({ items }: { items: TimelineItem[] }): React.JSX.Element | null {
  const work = items.filter((item) => item.kind !== "user");
  if (work.length === 0) return null;

  const finishedAt = items[items.length - 1]!.at;

  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70">
      {finishedAt > 0 && (
        <span title={new Date(finishedAt).toLocaleString()}>{clockTime(finishedAt)}</span>
      )}
      <span className="flex-1" />
      <CopyButton value={() => turnText(items)} label="Copy this turn" />
    </div>
  );
}

/**
 * How long the turn ran. Restored transcripts can be missing timestamps, and no
 * span reads better than a negative one.
 */
function span(items: TimelineItem[]): number | null {
  const first = items[0]!;
  const last = items[items.length - 1]!;
  return first.at > 0 && last.at >= first.at ? last.at - first.at : null;
}

/** "14:32" in whatever the user's locale calls that. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Splits the timeline where the user spoke. Anything before the first message —
 * a notice, an external agent's operation — becomes a turn of its own.
 */
function splitTurns(items: TimelineItem[]): TimelineItem[][] {
  const turns: TimelineItem[][] = [];

  for (const item of items) {
    if (item.kind === "user" || turns.length === 0) turns.push([item]);
    else turns[turns.length - 1]!.push(item);
  }

  return turns;
}

/**
 * What the copy button puts on the clipboard: the whole turn, operations
 * included. The typed message is left out.
 */
function turnText(items: TimelineItem[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "assistant":
        case "thinking":
        case "notice":
          return item.text;
        case "tool":
          return toolText(item);
        case "activity":
          return activityText(item.activity);
        default:
          return "";
      }
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/**
 * Consecutive operations, folded down to the one happening now. Kept in order:
 * the folded ones are older, so they sit above the live one.
 */
function Run({ items, busy }: { items: TimelineItem[]; busy: boolean }): React.JSX.Element {
  const folded = items.slice(0, -1);
  const latest = items[items.length - 1]!;

  return (
    <div className="flex flex-col gap-1.5">
      {folded.length > 0 && <Folded items={folded} busy={busy} />}
      <Row item={latest} busy={busy} />
    </div>
  );
}

function Folded({ items, busy }: { items: TimelineItem[]; busy: boolean }): React.JSX.Element {
  const failed = items.filter(hasFailed).length;
  const noun = items[0]?.kind === "tool" ? "tool call" : "Roblox operation";

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span>
          {items.length} earlier {noun}
          {items.length === 1 ? "" : "s"}
        </span>
        {/* Never let a fold hide a failure. */}
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1.5 flex flex-col gap-1.5 border-l-2 border-border pl-3">
          {items.map((item) => (
            <Row key={item.id} item={item} busy={busy} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type Grouped =
  | { kind: "single"; item: TimelineItem }
  | { kind: "run"; items: TimelineItem[] };

/** Runs of three or more neighbouring rows of the same kind are foldable. */
function groupRuns(items: TimelineItem[]): Grouped[] {
  const out: Grouped[] = [];
  let run: TimelineItem[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    // A disclosure that takes the same space as the row it hides is no gain.
    if (run.length < 3) out.push(...run.map((item) => ({ kind: "single" as const, item })));
    else out.push({ kind: "run", items: run });
    run = [];
  };

  for (const item of items) {
    const foldable = item.kind === "tool" || item.kind === "activity";

    if (foldable && (run.length === 0 || run[0]!.kind === item.kind)) {
      run.push(item);
      continue;
    }

    flush();

    if (foldable) run.push(item);
    else out.push({ kind: "single", item });
  }

  flush();
  return out;
}

function hasFailed(item: TimelineItem): boolean {
  if (item.kind === "tool") return item.isError;
  if (item.kind === "activity") return item.activity.status === "error";
  return false;
}

const WORKING_LABEL: Partial<Record<AgentState, string>> = {
  starting: "Starting",
  thinking: "Thinking",
  working: "Working",
};

/**
 * Proof of life: a long turn looks exactly like a hung one without it. Counted
 * from when the turn started, not from when this mounted — chats run in
 * parallel, so opening one already working mounts this fresh.
 */
function Working({ state, since }: { state: AgentState | undefined; since: number | null }): React.JSX.Element {
  const [elapsed, setElapsed] = React.useState(() => (since ? Math.max(0, Date.now() - since) : 0));

  React.useEffect(() => {
    const started = since ?? Date.now();
    setElapsed(Math.max(0, Date.now() - started));

    const timer = setInterval(() => setElapsed(Math.max(0, Date.now() - started)), 1_000);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <span className="flex gap-[3px]">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1 animate-pulse rounded-full bg-current"
            style={{ animationDelay: `${dot * 200}ms`, animationDuration: "1.2s" }}
          />
        ))}
      </span>
      {WORKING_LABEL[state ?? "working"] ?? "Working"} for {duration(elapsed)}
    </div>
  );
}

/** "8s", "5m 03s", "1h 04m" — precise where it is short, coarse where it is long. */
function duration(ms: number): string {
  const total = Math.floor(ms / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** The screen a new chat opens on. The examples are there to be clicked. */
function EmptyState({
  onExample,
  placeName,
}: {
  onExample: (text: string) => void;
  placeName: string | null;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-12">
      <div className="flex w-full max-w-[520px] flex-col items-center text-center">
        <BrandMark className="size-9" />

        <h1 className="mt-5 font-display text-[29px] leading-tight font-bold tracking-tight">
          What should we change?
        </h1>

        {placeName && <p className="mt-2 truncate text-[13.5px] text-muted-foreground">in {placeName}</p>}

        <div className="mt-7 flex flex-wrap justify-center gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => onExample(example)}
              className="rounded-full border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised on the entry itself. A streaming turn replaces one entry per token
 * and leaves the rest of the list identical, so without this every message in
 * the conversation re-parses its Markdown on every token that arrives.
 */
const Row = React.memo(function Row({
  item,
  busy,
}: {
  item: TimelineItem;
  busy: boolean;
}): React.JSX.Element | null {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1.5">
          {item.attachments && item.attachments.length > 0 && (
            <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
              {item.attachments.map((attachment) => (
                <img
                  key={attachment.id}
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.name}
                  className="max-h-40 rounded-lg border object-cover"
                />
              ))}
            </div>
          )}

          {item.text.length > 0 && (
            <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
              {item.text}
            </div>
          )}
        </div>
      );

    case "assistant":
      return <Markdown text={item.text} />;

    case "thinking":
      return (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
            <Brain className="size-3.5" />
            Thought
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="selectable mt-1.5 border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {item.text}
            </p>
          </CollapsibleContent>
        </Collapsible>
      );

    case "tool":
      return <Tool item={item} busy={busy} />;

    case "activity":
      return <Activity activity={item.activity} />;

    case "notice":
      return (
        <div
          className={cn(
            "selectable rounded-lg border px-3 py-2 text-[13px] leading-relaxed",
            item.tone === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {item.text}
        </div>
      );

    default:
      return null;
  }
});

/**
 * A tool call, openable. Collapsed it is a verb and its object — "Edit ·
 * ModelChip.tsx", from `describeTool`. Open, it is the whole call and the whole
 * result, untruncated and selectable.
 */
function Tool({ item, busy }: { item: Extract<TimelineItem, { kind: "tool" }>; busy: boolean }): React.JSX.Element {
  const input = format(item.input);
  const summary = describeTool(item.name, item.input);
  const Icon = TOOL_ICON[summary.icon];
  // Only spin while a turn could still answer. Some CLIs never send a result,
  // which would otherwise leave the row spinning forever.
  const pending = item.result === null && busy;

  return (
    <Collapsible>
      {/* A failure is marked, not highlighted. The reason folds away underneath,
          where a successful call keeps its result. */}
      <div
        className={cn(
          "group/row flex flex-col rounded-lg transition-colors hover:bg-muted/40",
          item.isError && "bg-destructive/5",
        )}
      >
        {/* Beside the disclosure, not inside it: a button nested in a button is
            neither valid nor clickable. */}
        <div className="flex items-center gap-1 pr-1">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pl-2 text-left">
            {item.isError ? (
              <CircleX className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            )}

            <span className="shrink-0 text-[13px] font-medium">{summary.label}</span>

            {summary.detail && (
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
                {truncate(summary.detail, 120)}
              </span>
            )}

            <span className="flex-1" />

            {pending ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              item.result !== null &&
              !item.isError && <Check className="size-3 shrink-0 text-[var(--success)] opacity-60" />
            )}

            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>

          <CopyButton value={() => toolText(item)} label="Copy" />
        </div>

        <CollapsibleContent>
          {/* Indented to the label, not the icon, so an open call sits under
              the line that named it. */}
          <div className="mt-0.5 mb-1 ml-[22px] flex flex-col gap-2 border-l pl-2.5">
            {/* The raw name lives in here: needed when debugging a tool, noise
                when reading what the agent did. */}
            <div className="font-mono text-[11px] text-muted-foreground">{item.name}</div>

            <Block label="Call" value={input} />
            {item.result !== null && (
              <Block
                label={item.isError ? "Error" : "Result"}
                value={item.result}
                tone={item.isError ? "error" : undefined}
              />
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Selectable, copyable, and scrolled rather than truncated. */
function Block({ label, value, tone }: { label: string; value: string; tone?: "error" }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        <span className="flex-1" />
        <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} withText />
      </div>

      <pre
        className={cn(
          "selectable max-h-[280px] overflow-auto rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
          tone === "error" ? "text-destructive" : "text-foreground/80",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

/**
 * A Roblox operation — one line, like everything else the agent did, with the
 * detail, the error, and the instances it touched folded underneath. A
 * screenshot is the exception and stays where it happened.
 */
function Activity({ activity }: { activity: ActivityEvent }): React.JSX.Element {
  const meta = CATEGORY[activity.category];
  const Icon = meta.icon;
  const failed = activity.status === "error";

  // A failure leads with its code, which is the word worth seeing unopened.
  const summary = failed ? (activity.error?.code ?? "Failed") : (activity.detail ?? "");

  const foldable =
    (activity.detail !== null && activity.detail.length > 0) ||
    activity.error !== null ||
    activity.instances.length > 0;

  return (
    <Collapsible>
      <div className="group/row flex flex-col rounded-lg bg-card/60 transition-colors hover:bg-card">
        <div className="flex items-center gap-1 pr-1">
          <CollapsibleTrigger
            disabled={!foldable}
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2.5 text-left"
          >
            {/* Same rule as a tool row: the mark in front carries the failure. */}
            {failed ? (
              <CircleX className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <Icon className={cn("size-3.5 shrink-0", meta.tone)} />
            )}

            <span className="min-w-0 shrink truncate text-[13.5px] font-medium">{activity.title}</span>

            {summary && (
              <span className={cn("min-w-0 flex-1 truncate text-[12px]", failed ? "font-mono text-destructive" : "text-muted-foreground")}>
                {summary}
              </span>
            )}

            <span className="flex-1" />

            {/* Every operation reaches the server over MCP, including this
                app's own, so a missing chat is what marks one external. */}
            {activity.chat === null && <Badge variant="outline">external agent</Badge>}

            {activity.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
            {activity.status === "ok" && <CircleCheck className="size-3.5 shrink-0 text-[var(--success)] opacity-60" />}

            {foldable && (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            )}
          </CollapsibleTrigger>

          <CopyButton value={() => activityText(activity)} label="Copy" />
        </div>

        <CollapsibleContent>
          <div className="mt-0.5 mb-1.5 ml-[22px] flex flex-col gap-1.5 border-l pl-2.5">
            {activity.detail && (
              <div className="selectable text-[12.5px] leading-relaxed text-muted-foreground">{activity.detail}</div>
            )}

            {activity.error && (
              <div className="selectable">
                <div className="text-[12.5px] leading-relaxed text-destructive">
                  <span className="font-mono text-[11.5px] opacity-80">{activity.error.code}</span>{" "}
                  {activity.error.message}
                </div>
                {activity.error.hint && (
                  <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{activity.error.hint}</div>
                )}
              </div>
            )}

            {activity.instances.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {activity.instances.slice(0, 8).map((instance) => (
                  <code
                    key={instance.handle}
                    className="selectable rounded bg-muted px-1.5 py-px font-mono text-[11.5px] text-muted-foreground"
                  >
                    {instance.path}
                  </code>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>

        {activity.image && (
          <img
            className="mx-2.5 mt-1 mb-2.5 rounded-md border"
            src={`data:${activity.image.mimeType};base64,${activity.image.data}`}
            alt="Studio screenshot"
          />
        )}
      </div>
    </Collapsible>
  );
}

/**
 * Copy, everywhere something is worth having exactly. `value` may be a function
 * so a row builds its text only when pressed — a screenshot's base64 should not
 * be assembled on every render. Always drawn, dimmed rather than hidden.
 */
function CopyButton({
  value,
  label,
  withText,
  className,
}: {
  value: string | (() => string);
  label: string;
  withText?: boolean;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    const text = typeof value === "function" ? value() : value;
    if (!(await writeClipboard(text))) return;

    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // Rows are clickable — a copy is not also a request to open the thing.
        event.stopPropagation();
        void copy();
      }}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11.5px] transition-colors",
        "text-muted-foreground/45 hover:text-foreground group-hover/row:text-muted-foreground",
        withText && "text-muted-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
      {withText && (copied ? "Copied" : "Copy")}
    </button>
  );
}

/**
 * Writes to the clipboard, or says it could not. `navigator.clipboard` rejects
 * from a window Chromium considers unfocused; the deprecated execCommand path
 * is the only one that works there.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through.
  }

  const staging = document.createElement("textarea");
  staging.value = text;
  staging.setAttribute("readonly", "");
  staging.style.position = "fixed";
  staging.style.opacity = "0";
  document.body.appendChild(staging);

  try {
    staging.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    staging.remove();
  }
}

/** A tool call as text: the name, what it was given, and what came back. */
function toolText(item: Extract<TimelineItem, { kind: "tool" }>): string {
  const parts = [item.name, format(item.input)].filter((part) => part.length > 0);
  if (item.result !== null) parts.push(`${item.isError ? "Error" : "Result"}:\n${item.result}`);
  return parts.join("\n\n");
}

/** A Roblox operation as text, in the same language the row shows it in. */
function activityText(activity: ActivityEvent): string {
  const parts = [activity.title];

  if (activity.detail) parts.push(activity.detail);

  // An insert puts instances in the place the same way an edit does.
  if ((activity.category === "edit" || activity.category === "assets") && activity.instances.length > 0) {
    parts.push(activity.instances.map((instance) => instance.path).join("\n"));
  }

  if (activity.error) {
    parts.push(`Error: ${activity.error.code} ${activity.error.message}`);
    if (activity.error.hint) parts.push(activity.error.hint);
  }

  return parts.join("\n\n");
}

/** Readable in full when opened, so this indents rather than truncating. */
function format(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;

  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
