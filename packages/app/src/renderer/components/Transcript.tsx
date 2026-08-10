/**
 * The conversation, with Roblox activity shown inline.
 *
 * Studio operations appear in Roblox language rather than as tool identifiers,
 * and screenshots the agent captured are shown where they happened, so the user
 * can follow the work without reading protocol traffic. Spec sections 7 and 33.
 */
import * as React from "react";
import {
  AlertTriangle,
  Brain,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  Copy,
  Eye,
  Gamepad2,
  Loader2,
  MonitorPlay,
  Pencil,
  ScrollText,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { ActivityEvent } from "@luumen/code-protocol";
import type { AgentState } from "../../shared/agent.js";
import { BrandMark } from "@/components/Brand";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/misc";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/state";

const CATEGORY: Record<ActivityEvent["category"], { label: string; icon: React.ElementType; tone: string }> = {
  inspect: { label: "Inspect", icon: Eye, tone: "text-sky-400/90" },
  edit: { label: "Edit", icon: Pencil, tone: "text-violet-400/90" },
  playtest: { label: "Playtest", icon: MonitorPlay, tone: "text-[var(--success)]" },
  output: { label: "Output", icon: ScrollText, tone: "text-muted-foreground" },
  runtime: { label: "Runtime", icon: SquareTerminal, tone: "text-amber-400/90" },
  visual: { label: "Screenshot", icon: Camera, tone: "text-[var(--warning)]" },
  input: { label: "Input", icon: Gamepad2, tone: "text-cyan-400/90" },
};

const EXAMPLES = [
  "Fix the error when I click Buy",
  "Make the inventory UI open and close",
  "Brighten the lobby, then screenshot it",
];

export function Transcript({
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
    // Only follow along when the user is already at the bottom; yanking them
    // away from something they are reading is worse than a missed message.
    if (!pinned.current) return;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
    // `busy` too: the working line appearing changes the height, and the point
    // of it is to be seen.
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
  const runs = groupRuns(visible);

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onScrollCapture={onScroll}>
      <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-6 py-6">
        {runs.map((run) =>
          run.kind === "single" ? (
            <Row key={run.item.id} item={run.item} busy={busy} />
          ) : (
            <Run key={run.items[0]!.id} items={run.items} busy={busy} />
          ),
        )}

        {busy && <Working state={state} />}
      </div>
    </ScrollArea>
  );
}

/**
 * Consecutive operations, folded down to the one happening now.
 *
 * A turn that inspects six things and edits two is eight rows of scrollback
 * that push the conversation off the screen, and only the last of them is what
 * the agent is doing right now. The earlier ones stay one click away.
 *
 * Kept in order — the folded ones are older, so they sit above the live one.
 * A transcript that puts the newest row on top and its history underneath
 * reads backwards.
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
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
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
    // Two in a row is not clutter; folding one row behind a disclosure that
    // takes the same space as the row would be theatre.
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
 * Proof of life.
 *
 * A long turn — a playtest, a screenshot, a model that is thinking hard — looks
 * exactly like a hung one. The elapsed time is the difference: it says the app
 * is still with you, and it is the number you quote when something really has
 * stopped.
 */
function Working({ state }: { state: AgentState | undefined }): React.JSX.Element {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    // Mounts when the turn starts and unmounts when it ends, so the clock
    // belongs to this turn rather than needing to be reset.
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
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

/**
 * The screen a new chat opens on.
 *
 * A blank chat is not the place to explain the product. It says where you are
 * and asks the one question, and the examples are there to be clicked, not
 * read: three short lines, not a feature list.
 */
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

        <h1 className="mt-5 font-display text-[27px] leading-tight font-bold tracking-tight">
          What should we change?
        </h1>

        {placeName && <p className="mt-2 truncate text-[12.5px] text-muted-foreground">in {placeName}</p>}

        <div className="mt-7 flex flex-wrap justify-center gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => onExample(example)}
              className="rounded-full border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ item, busy }: { item: TimelineItem; busy: boolean }): React.JSX.Element | null {
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
            <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
              {item.text}
            </div>
          )}
        </div>
      );

    case "assistant":
      return <Prose text={item.text} />;

    case "thinking":
      return (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground">
            <Brain className="size-3.5" />
            Thought
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="selectable mt-1.5 border-l-2 border-border pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
            "selectable rounded-lg border px-3 py-2 text-[12px] leading-relaxed",
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
}

/**
 * A tool call, openable.
 *
 * Collapsed it is one line, because most of them are not what you are reading
 * the transcript for. Open, it is the whole call and the whole result, as text
 * you can select and copy — when a tool misbehaves, the exact arguments and the
 * exact output are the only things worth having, and a truncated preview of
 * either is the same as nothing.
 */
function Tool({ item, busy }: { item: Extract<TimelineItem, { kind: "tool" }>; busy: boolean }): React.JSX.Element {
  const input = format(item.input);
  // Only spin while there is a turn that could still answer. A CLI that never
  // sends a result for a call — and they differ on this — would otherwise leave
  // a row spinning for the rest of the conversation, and for every conversation
  // after it was reloaded from disk.
  const pending = item.result === null && busy;

  return (
    <Collapsible>
      <div
        className={cn(
          "rounded-lg border bg-card/40 transition-colors",
          item.isError && "border-destructive/30 bg-destructive/[0.06]",
        )}
      >
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground">
          <Wrench className={cn("size-3.5 shrink-0", item.isError && "text-destructive")} />
          <span className="shrink-0 font-mono text-foreground/80">{item.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono opacity-70">{truncate(input, 110)}</span>

          {pending && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
          {item.isError && <Badge variant="destructive">failed</Badge>}

          <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex flex-col gap-2 border-t px-2.5 py-2">
            <Block label="Call" value={input} />
            {item.result !== null && <Block label="Result" value={item.result} tone={item.isError ? "error" : undefined} />}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Selectable, copyable, and scrolled rather than truncated. */
function Block({ label, value, tone }: { label: string; value: string; tone?: "error" }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        <span className="flex-1" />
        <button
          onClick={() => void copy()}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-[var(--success)]" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre
        className={cn(
          "selectable max-h-[280px] overflow-auto rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap",
          tone === "error" ? "text-destructive" : "text-foreground/80",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function Activity({ activity }: { activity: ActivityEvent }): React.JSX.Element {
  const meta = CATEGORY[activity.category];
  const Icon = meta.icon;
  const failed = activity.status === "error";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 px-3 py-2 transition-colors",
        failed && "border-destructive/30 bg-destructive/[0.06]",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-3.5 shrink-0", failed ? "text-destructive" : meta.tone)} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{activity.title}</span>

        {activity.origin === "mcp" && <Badge variant="outline">external agent</Badge>}

        {activity.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {activity.status === "ok" && <CircleCheck className="size-3.5 shrink-0 text-[var(--success)] opacity-60" />}
        {failed && <AlertTriangle className="size-3.5 shrink-0 text-destructive" />}
      </div>

      {activity.detail && !failed && (
        <div className="mt-1 pl-[22px] text-[11.5px] text-muted-foreground">{activity.detail}</div>
      )}

      {activity.error && (
        <div className="selectable mt-1.5 pl-[22px]">
          <div className="text-[11.5px] leading-relaxed text-destructive">
            <span className="font-mono text-[10.5px] opacity-80">{activity.error.code}</span> {activity.error.message}
          </div>
          {activity.error.hint && (
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{activity.error.hint}</div>
          )}
        </div>
      )}

      {activity.image && (
        <img
          className="mt-2.5 w-full rounded-md border"
          src={`data:${activity.image.mimeType};base64,${activity.image.data}`}
          alt="Roblox Studio screenshot captured by the agent"
        />
      )}

      {activity.category === "edit" && activity.instances.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[22px]">
          {activity.instances.slice(0, 4).map((instance) => (
            <code
              key={instance.handle}
              className="selectable rounded bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground"
            >
              {instance.path}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Just enough formatting for agent output: fenced code and paragraphs. A full
 * Markdown renderer would be a dependency and an attack surface for very little
 * gain here.
 */
function Prose({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/```(?:[\w-]*\n)?/);

  return (
    <div className="selectable flex flex-col gap-2 text-[13px] leading-relaxed">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
          >
            {part.replace(/\n$/, "")}
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((paragraph) => paragraph.trim().length > 0)
            .map((paragraph, inner) => (
              <p key={`${index}-${inner}`} className="whitespace-pre-wrap">
                {paragraph}
              </p>
            ))
        ),
      )}
    </div>
  );
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
