/**
 * What was done to the place, and the button that takes it back. One row per
 * instance and kind, which is what a bundle already is: a name, what moved, and
 * `+12 −3`. The plugin's sentence is the row's title attribute.
 *
 * The same list appears in the dock, where it is the session's whole history
 * with the diffs open, and under a turn in the transcript, where it is what
 * that turn did and starts folded.
 */
import * as React from "react";
import {
  ChevronRight,
  CircleAlert,
  FileCode2,
  FilePlus2,
  History,
  Loader2,
  Maximize2,
  Move,
  Pencil,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ChangeRecord, RevertOutcome } from "@luumen/code-protocol";
import { isPending } from "@luumen/code-protocol";
import { ChangeDiff } from "@/components/ChangeDiff";
import { bundleChanges, bundleLabel, bundleStats, hasDocument } from "@/components/changeDocument";
import type { ChangeBundle, ChangeStats } from "@/components/changeDocument";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/misc";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

const KIND_ICON: Record<ChangeRecord["kind"], React.ElementType> = {
  properties: Pencil,
  attributes: Pencil,
  tags: Tag,
  rename: Pencil,
  reparent: Move,
  create: FilePlus2,
  delete: Trash2,
  source: FileCode2,
};

/**
 * The outcome of the last revert attempt on each row. Not part of the record —
 * a refusal leaves what happened to the place unchanged.
 */
type Outcomes = Record<string, RevertOutcome>;

function useRevert(harness: Harness): {
  outcomes: Outcomes;
  run: (records: ChangeRecord[], force?: boolean) => Promise<void>;
} {
  const [outcomes, setOutcomes] = React.useState<Outcomes>({});

  const run = React.useCallback(
    async (records: ChangeRecord[], force = false) => {
      const ids = records.filter(isPending).map((record) => record.id);
      if (ids.length === 0) return;

      // Clear what was said last time: a stale conflict must not sit under a
      // row that has just gone back cleanly.
      setOutcomes((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });

      const results = await harness.revert(ids, force);

      setOutcomes((current) => {
        const next = { ...current };
        for (const outcome of results) {
          if (outcome.status === "reverted") delete next[outcome.id];
          else next[outcome.id] = outcome;
        }
        return next;
      });
    },
    [harness],
  );

  return { outcomes, run };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Counted over the merged changes, not the records, so the header agrees with
 * the rows under it.
 */
function sum(records: ChangeRecord[]): ChangeStats {
  let added = 0;
  let removed = 0;

  for (const bundle of bundleChanges(records)) {
    const stats = bundleStats(bundle);
    added += stats.added;
    removed += stats.removed;
  }

  return { added, removed };
}

/** `+12 −3` — how big the diff is, before it is opened. */
function Stats({ stats, className }: { stats: ChangeStats; className?: string }): React.JSX.Element | null {
  if (stats.added === 0 && stats.removed === 0) return null;

  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums", className)}>
      {stats.added > 0 && <span className="text-[var(--success)]">+{stats.added}</span>}
      {stats.removed > 0 && <span className="text-destructive">−{stats.removed}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The dock panel
// ---------------------------------------------------------------------------

export function ChangesTab({ harness }: { harness: Harness }): React.JSX.Element {
  const { outcomes, run } = useRevert(harness);
  const pending = React.useMemo(() => harness.changes.filter(isPending), [harness.changes]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
        <span className="text-[12px] text-muted-foreground">
          {harness.changes.length === 0 ? "" : `${pending.length} of ${harness.changes.length} applied`}
        </span>

        <Stats stats={sum(pending)} />

        <span className="flex-1" />

        {pending.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={harness.reverting.length > 0}
            onClick={() => void run(pending)}
          >
            <Undo2 />
            Revert all
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2.5 pb-3">
          {harness.changes.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">Nothing yet.</p>
          ) : (
            <ChangeList records={harness.changes} harness={harness} outcomes={outcomes} onRevert={run} startOpen />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One change
// ---------------------------------------------------------------------------

/**
 * A flat list of changes. No instance grouping — the rows carry their own
 * paths, and grouping would put a heading around each single row.
 */
function ChangeList({
  records,
  harness,
  outcomes,
  onRevert,
  live,
  startOpen,
}: {
  records: ChangeRecord[];
  harness: Harness;
  outcomes: Outcomes;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
  /** Ids still in the live journal. Absent means every record is live. */
  live?: ReadonlySet<string>;
  /** Start every diff open. The dock is the panel you go to to read them. */
  startOpen?: boolean;
}): React.JSX.Element {
  const bundles = bundleChanges(records);

  return (
    <div className="flex flex-col rounded-lg border bg-card/40">
      {bundles.map((bundle) => (
        <ChangeRow
          key={bundle.key}
          bundle={bundle}
          harness={harness}
          outcomes={outcomes}
          onRevert={onRevert}
          stale={live !== undefined && bundle.records.every((record) => !live.has(record.id))}
          showPath={bundles.length > 1}
          startOpen={startOpen}
        />
      ))}
    </div>
  );
}

/**
 * Whether the row has come near the viewport yet. The dock opens every diff at
 * once, so a session of thirty would build thirty before it paints. Once seen
 * it stays seen: unmounting would collapse the height under the scroll.
 */
function useSeen(): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [seen, setSeen] = React.useState(false);

  React.useEffect(() => {
    if (seen) return;

    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      // Built a screen early, so scrolling reaches a diff that is already there.
      { rootMargin: "400px 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return [ref, seen];
}

/**
 * The diff, built when it is nearly on screen. The placeholder is sized from
 * the line counts so the scrollbar does not jump when it is replaced.
 */
function LazyDiff({ bundle, stats }: { bundle: ChangeBundle; stats: ChangeStats }): React.JSX.Element {
  const [ref, seen] = useSeen();
  const estimate = Math.min(420, Math.max(80, (stats.added + stats.removed) * 18));

  return (
    <div ref={ref} className="max-h-[420px] overflow-auto rounded-md">
      {seen ? <ChangeDiff bundle={bundle} /> : <div style={{ height: estimate }} />}
    </div>
  );
}

/**
 * One instance's change, however many operations it took. Reverting the row
 * puts every operation in the bundle back, newest first. A record that has
 * already gone back is in a bundle of its own.
 */
function ChangeRow({
  bundle,
  harness,
  outcomes,
  onRevert,
  stale,
  showPath,
  startOpen,
}: {
  bundle: ChangeBundle;
  harness: Harness;
  outcomes: Outcomes;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
  /** Read back from the thread file: the diff is real, the revert is gone. */
  stale?: boolean;
  showPath?: boolean;
  startOpen?: boolean;
}): React.JSX.Element {
  const records = bundle.records;
  // The newest holds where the instance is now and what last happened to it.
  const record = records[records.length - 1]!;

  const Icon = KIND_ICON[bundle.kind];
  const reverted = records.every((entry) => !isPending(entry));
  const busy = records.some((entry) => harness.reverting.includes(entry.id));
  const label = bundleLabel(bundle);
  const stats = bundleStats(bundle);
  const open = useOpenChange();
  // Whether there is a document, not what its diff looks like. ChangeDiff does
  // the diffing, once the row is open.
  const detail = React.useMemo(() => hasDocument(bundle), [bundle]);

  // Everything in the bundle goes back together.
  const pending = records.filter(isPending);
  const outcome = records.map((entry) => outcomes[entry.id]).find((entry) => entry !== undefined);
  const revertable = pending.length > 0 && pending.every((entry) => entry.revertable);

  /* The plugin's sentence sits on hover, as the row's title. */
  const face = (
    <>
      {detail && (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/change:rotate-90" />
      )}

      <Icon className={cn("size-3.5 shrink-0", reverted ? "text-muted-foreground/50" : "text-violet-400/90")} />

      <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={record.summary}>
        <span
          className={cn("min-w-0 truncate font-mono text-[12px]", reverted && "text-muted-foreground line-through")}
        >
          {label.name}
        </span>
        {label.detail && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">{label.detail}</span>
        )}
      </span>

      <Stats stats={stats} className={cn(reverted && "opacity-50")} />
    </>
  );

  const row = (
    <div className="group/row flex items-center gap-1.5 pr-1 transition-colors hover:bg-accent/30">
      {detail ? (
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 text-left">
          {face}
        </CollapsibleTrigger>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5">{face}</div>
      )}

      {detail && (
        <Hint label="Open over the chat">
          <button
            type="button"
            onClick={() => open?.(records.map((entry) => entry.id))}
            className="shrink-0 rounded p-1 text-muted-foreground/45 transition-colors group-hover/row:text-muted-foreground hover:text-foreground"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </Hint>
      )}

      {busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : reverted ? (
        <span className="shrink-0 pr-1 text-[11px] text-muted-foreground/70">Reverted</span>
      ) : stale ? (
        // No button and no reason on the row; the section header says it once.
        <History className="mr-1 size-3.5 shrink-0 text-muted-foreground/40" />
      ) : revertable ? (
        <Hint label={pending.length > 1 ? `Revert all ${pending.length}` : "Revert"}>
          <button
            type="button"
            disabled={harness.reverting.length > 0}
            onClick={() => void onRevert(pending)}
            className="shrink-0 rounded p-1 text-muted-foreground/45 transition-colors group-hover/row:text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Undo2 className="size-3.5" />
          </button>
        </Hint>
      ) : null}
    </div>
  );

  return (
    <div className="border-t first:border-t-0">
      {detail ? (
        /* Closed in the transcript, where a diff unfolding under the answer
           takes the scroll position with it. Open in the dock. */
        <Collapsible className="group/change" defaultOpen={startOpen}>
          {row}
          <CollapsibleContent>
            <div className="px-2.5 pb-2">
              {showPath && (
                <code className="selectable mb-1 block truncate font-mono text-[11px] text-muted-foreground/70">
                  {record.target.path}
                </code>
              )}
              <LazyDiff bundle={bundle} stats={stats} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        row
      )}

      {!stale && <RowNote pending={pending} outcome={outcome} busy={busy} onRevert={onRevert} />}
    </div>
  );
}

/**
 * Whatever the last attempt had to say, and nothing when it had nothing. A
 * change that cannot go back gets the reason rather than a disabled button.
 */
function RowNote({
  pending,
  outcome,
  busy,
  onRevert,
}: {
  /** The records under this row that are still applied. */
  pending: ChangeRecord[];
  outcome: RevertOutcome | undefined;
  busy: boolean;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
}): React.JSX.Element | null {
  if (pending.length === 0) return null;

  // One operation stuck means the row is stuck: putting half a run back would
  // leave the instance in a state nothing describes.
  const stuck = pending.find((record) => !record.revertable);

  if (stuck) {
    return (
      <p className="px-2.5 pb-2 pl-[30px] text-[11.5px] leading-relaxed text-muted-foreground">
        {stuck.reason ?? "This change cannot be put back."}
      </p>
    );
  }

  if (!outcome) return null;

  return (
    <div className="px-2.5 pb-2 pl-[30px]">
      <p
        className={cn(
          "flex items-start gap-1.5 text-[11.5px] leading-relaxed",
          outcome.status === "conflict" ? "text-[var(--warning)]" : "text-destructive",
        )}
      >
        <CircleAlert className="mt-px size-3 shrink-0" />
        <span className="selectable">{outcome.reason ?? "It could not be put back."}</span>
      </p>

      {outcome.current && <p className="pl-[18px] text-[11px] text-muted-foreground">Now: {outcome.current}</p>}

      {/* Only a conflict is worth overriding. A failure is Roblox refusing the
          write. */}
      {outcome.status === "conflict" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRevert(pending, true)}
          className="mt-1 ml-[18px] text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          Revert anyway
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// In the transcript
// ---------------------------------------------------------------------------

interface ChangesContextValue {
  harness: Harness;
  /**
   * Opens one change over the conversation. Every record behind the row, so the
   * viewer shows the same diff the row did.
   */
  open: (ids: string[]) => void;
}

/**
 * The harness and the viewer, for the transcript's turns. Through context: the
 * transcript renders turns inside folds inside runs, and only the row at the
 * bottom needs either.
 */
const ChangesContext = React.createContext<ChangesContextValue | null>(null);

export function ChangesProvider({
  harness,
  onOpen,
  children,
}: {
  harness: Harness;
  onOpen: (ids: string[]) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = React.useMemo(() => ({ harness, open: onOpen }), [harness, onOpen]);
  return <ChangesContext.Provider value={value}>{children}</ChangesContext.Provider>;
}

function useOpenChange(): ((ids: string[]) => void) | null {
  return React.useContext(ChangesContext)?.open ?? null;
}

/**
 * What a turn changed, at the top of the turn beside the answer — behind one
 * fold whose header carries the count and the totals. Not on the operation row
 * that caused it, which sits inside two other folds.
 */
export function TurnChanges({ activityIds }: { activityIds: string[] }): React.JSX.Element | null {
  const context = React.useContext(ChangesContext);
  if (!context) return null;
  return <TurnChangeList harness={context.harness} activityIds={activityIds} />;
}

function TurnChangeList({
  harness,
  activityIds,
}: {
  harness: Harness;
  activityIds: string[];
}): React.JSX.Element | null {
  const { outcomes, run } = useRevert(harness);

  /**
   * The turn's changes, live where they still are and stored where they are
   * not. The live journal wins on a record they both hold — it knows whether
   * the change has since been put back.
   */
  const records = React.useMemo(() => {
    const wanted = new Set(activityIds);
    const live = new Set(harness.changes.map((record) => record.id));

    return [
      ...harness.changes.filter((record) => wanted.has(record.activityId)),
      ...harness.history.filter((record) => wanted.has(record.activityId) && !live.has(record.id)),
    ].sort((left, right) => left.at - right.at);
  }, [harness.changes, harness.history, activityIds]);

  const live = React.useMemo(() => new Set(harness.changes.map((record) => record.id)), [harness.changes]);

  if (records.length === 0) return null;

  const pending = records.filter((record) => isPending(record) && live.has(record.id));
  const allReverted = records.every((record) => !isPending(record));
  // Nothing here can be put back, and not because it already has been.
  const stale = !allReverted && records.every((record) => !live.has(record.id));

  return (
    /* Folded by default: a turn that touched thirty instances would otherwise
       put thirty rows between the answer and the next message. */
    <Collapsible className="group/turn flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <CollapsibleTrigger className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground">
          <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/turn:rotate-90" />
          <span>{records.length === 1 ? "1 change" : `${records.length} changes`}</span>
          <Stats stats={sum(records)} />
        </CollapsibleTrigger>

        {allReverted && <span className="text-muted-foreground/70">· reverted</span>}
        {stale && (
          <Hint label="That Studio session has ended. This is here to read.">
            <span className="text-muted-foreground/70 underline decoration-dotted underline-offset-2">
              · from an earlier session
            </span>
          </Hint>
        )}

        <span className="flex-1" />

        {pending.length > 1 && (
          <button
            type="button"
            disabled={harness.reverting.length > 0}
            onClick={() => void run(pending)}
            className="flex items-center gap-1 transition-colors hover:text-foreground disabled:opacity-50"
          >
            <Undo2 className="size-3" />
            Revert all
          </button>
        )}
      </div>

      <CollapsibleContent>
        <ChangeList records={records} harness={harness} outcomes={outcomes} onRevert={run} live={live} />
      </CollapsibleContent>
    </Collapsible>
  );
}
