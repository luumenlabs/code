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
  ChevronRight,
  CircleCheck,
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
  "Fix the inventory UI so it opens, and make the buy button actually purchase the selected item.",
  "The shop errors when I click Buy. Play it, find out why, and fix it.",
  "Make the lobby spawn brighter, then show me a screenshot.",
];

export function Transcript({
  items,
  onExample,
  showThinking,
}: {
  items: TimelineItem[];
  onExample: (text: string) => void;
  showThinking: boolean;
}): React.JSX.Element {
  const viewport = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    // Only follow along when the user is already at the bottom; yanking them
    // away from something they are reading is worse than a missed message.
    if (!pinned.current) return;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items]);

  const onScroll = (): void => {
    const element = viewport.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
  };

  if (items.length === 0) {
    return <EmptyState onExample={onExample} />;
  }

  const visible = showThinking ? items : items.filter((item) => item.kind !== "thinking");

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onScrollCapture={onScroll}>
      <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-6 py-6">
        {visible.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </div>
    </ScrollArea>
  );
}

function EmptyState({ onExample }: { onExample: (text: string) => void }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8">
      <div className="w-full max-w-[580px]">
        <BrandMark className="mb-5 size-8" />

        <h1 className="font-display text-[26px] leading-tight font-bold tracking-tight">
          Use Claude Code or Codex with Roblox Studio
        </h1>
        <p className="mt-3 max-w-[52ch] text-[13.5px] leading-relaxed text-muted-foreground">
          Describe a change to your game. The agent can inspect the DataModel, edit scripts, start a playtest, read
          Studio output, interact with the running game, and check its own work.
        </p>

        <div className="mt-7 flex flex-col gap-1">
          <span className="eyebrow mb-1">Try</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => onExample(example)}
              className="row group flex items-start gap-2.5 px-3 py-2.5 text-left"
            >
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              <span className="text-[12.5px] leading-relaxed text-muted-foreground group-hover:text-foreground">
                {example}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ item }: { item: TimelineItem }): React.JSX.Element | null {
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
      return (
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <Wrench className="size-3.5 shrink-0" />
          <span className="shrink-0 font-mono text-foreground/80">{item.name}</span>
          <span className="truncate font-mono opacity-70">{summarize(item.input)}</span>
          {item.isError && <Badge variant="destructive">failed</Badge>}
        </div>
      );

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

function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 110);

  try {
    return truncate(JSON.stringify(input), 110);
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
