/**
 * What was done to the place, and the button that takes it back.
 *
 * Grouped by instance rather than listed by time. A session's changes read as
 * fifteen indistinguishable lines when they are a timeline, and as "three things
 * happened to the Shop" when they are grouped — and the instance is what the
 * user is deciding about anyway.
 *
 * The same list appears in two widths: the dock, where it is the session's whole
 * history, and under a turn in the transcript, where it is what that turn did.
 * Both use the components below so a change looks the same and reverts the same
 * wherever it is read.
 *
 * A row is a filename, what moved, and `+12 −3`. It used to be the plugin's
 * sentence — "Changed the source of Shop" — which is the right thing to hand an
 * agent and the wrong thing to stack down a panel, because prose does not scan
 * and does not align. The sentence is still on the row, as its title.
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
import { groupChanges, isPending } from "@luumen/code-protocol";
import { ChangeDiff } from "@/components/ChangeDiff";
import { changeLabel, changeStats, hasDocument } from "@/components/changeDocument";
import type { ChangeStats } from "@/components/changeDocument";
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
 * The outcome of the last attempt on each row.
 *
 * Kept here rather than in the record, because it is not part of what happened
 * to the place — it is what the app just tried and was told. A conflict has to
 * stay on screen next to its row until the user does something about it, and
 * the record itself is unchanged by a refusal.
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

      // Clear what was said last time first: a stale conflict sitting under a
      // row that has just gone back cleanly is worse than no message.
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

function sum(records: ChangeRecord[]): ChangeStats {
  let added = 0;
  let removed = 0;

  for (const record of records) {
    const stats = changeStats(record);
    added += stats.added;
    removed += stats.removed;
  }

  return { added, removed };
}

/**
 * `+12 −3`.
 *
 * The one thing a diff should say before it is opened, and the thing this
 * product was not saying anywhere: how big it is. A row without it is a row you
 * have to open to find out whether it was worth opening.
 */
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
  const groups = React.useMemo(() => groupChanges(harness.changes), [harness.changes]);
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
        <div className="flex flex-col gap-2 px-2.5 pb-3">
          {groups.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">Nothing yet.</p>
          ) : (
            groups.map((group) => (
              <InstanceGroup
                key={group.key}
                path={group.path}
                className={group.target.className}
                records={group.records}
                harness={harness}
                outcomes={outcomes}
                onRevert={run}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function InstanceGroup({
  path,
  className,
  records,
  harness,
  outcomes,
  onRevert,
}: {
  path: string;
  className: string;
  records: ChangeRecord[];
  harness: Harness;
  outcomes: Outcomes;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
}): React.JSX.Element {
  const pending = records.filter(isPending);
  const name = path.split(/[.[]/).pop()?.replace(/["\]]/g, "") ?? path;

  return (
    <div className="rounded-lg border bg-card/40">
      <div className="group/row flex items-center gap-1.5 px-2.5 pt-2 pb-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium">{name}</span>
            <span className="shrink-0 text-[11.5px] text-muted-foreground">{className}</span>
          </div>
          <code className="selectable block truncate font-mono text-[11px] text-muted-foreground/70" title={path}>
            {path}
          </code>
        </div>

        {pending.length > 1 && (
          <Hint label={`Revert ${pending.length}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              disabled={harness.reverting.length > 0}
              onClick={() => void onRevert(pending)}
            >
              <Undo2 />
            </Button>
          </Hint>
        )}
      </div>

      <div className="flex flex-col">
        {records.map((record) => (
          <ChangeRow
            key={record.id}
            record={record}
            harness={harness}
            outcome={outcomes[record.id]}
            onRevert={onRevert}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One change
// ---------------------------------------------------------------------------

/**
 * A flat list of changes, for the transcript.
 *
 * No instance grouping: the rows carry their own paths, and a turn that touched
 * four instances would otherwise become four headings around four single rows.
 */
function ChangeList({
  records,
  harness,
  outcomes,
  onRevert,
  live,
  defaultOpen,
}: {
  records: ChangeRecord[];
  harness: Harness;
  outcomes: Outcomes;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
  /** Ids still in the live journal. Absent means every record is live. */
  live?: ReadonlySet<string>;
  /** Whether the diffs start open. See `TurnChanges`. */
  defaultOpen?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col rounded-lg border bg-card/40">
      {records.map((record) => (
        <ChangeRow
          key={record.id}
          record={record}
          harness={harness}
          outcome={outcomes[record.id]}
          onRevert={onRevert}
          stale={live !== undefined && !live.has(record.id)}
          showPath={records.length > 1}
          defaultOpen={defaultOpen}
        />
      ))}
    </div>
  );
}

function ChangeRow({
  record,
  harness,
  outcome,
  onRevert,
  stale,
  showPath,
  defaultOpen,
}: {
  record: ChangeRecord;
  harness: Harness;
  outcome: RevertOutcome | undefined;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
  /** Read back from the thread file: the diff is real, the revert is gone. */
  stale?: boolean;
  showPath?: boolean;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const Icon = KIND_ICON[record.kind];
  const reverted = !isPending(record);
  const busy = harness.reverting.includes(record.id);
  const label = changeLabel(record);
  const stats = changeStats(record);
  const open = useOpenChange();
  // Cheap: whether there is a document, not what the diff of it looks like.
  // The diffing itself happens in ChangeDiff, and only once the row is open.
  const detail = React.useMemo(() => hasDocument(record), [record]);

  /* The plugin's sentence, kept where a sentence belongs: on hover, for the one
     time in fifty that "what exactly did this do" is the question. */
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
            onClick={() => open?.(record.id)}
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
        // No button and no explanation on the row: the section above says why
        // once, which is the right number of times for something that is true
        // of everything under it.
        <History className="mr-1 size-3.5 shrink-0 text-muted-foreground/40" />
      ) : record.revertable ? (
        <Hint label="Revert">
          <button
            type="button"
            disabled={harness.reverting.length > 0}
            onClick={() => void onRevert([record])}
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
        <Collapsible className="group/change" defaultOpen={defaultOpen}>
          {row}
          <CollapsibleContent>
            <div className="px-2.5 pb-2">
              {showPath && (
                <code className="selectable mb-1 block truncate font-mono text-[11px] text-muted-foreground/70">
                  {record.target.path}
                </code>
              )}
              <div className="max-h-[420px] overflow-auto rounded-md">
                <ChangeDiff record={record} />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        row
      )}

      {!stale && <RowNote record={record} outcome={outcome} busy={busy} onRevert={onRevert} />}
    </div>
  );
}

/**
 * Whatever the last attempt had to say, and nothing when it had nothing.
 *
 * A change that cannot go back gets the reason rather than a disabled button:
 * a button you cannot press tells you nothing about why, and "Archivable is off
 * on this instance" is the whole answer. A change that went back cleanly, or
 * has not been tried, draws no row at all — this used to be a permanent strip
 * under every change holding a Revert link that now lives on the row itself.
 */
function RowNote({
  record,
  outcome,
  busy,
  onRevert,
}: {
  record: ChangeRecord;
  outcome: RevertOutcome | undefined;
  busy: boolean;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
}): React.JSX.Element | null {
  if (!isPending(record)) return null;

  if (!record.revertable) {
    return (
      <p className="px-2.5 pb-2 pl-[30px] text-[11.5px] leading-relaxed text-muted-foreground">
        {record.reason ?? "This change cannot be put back."}
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
          write, and asking again harder does not change that. */}
      {outcome.status === "conflict" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRevert([record], true)}
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
  /** Opens one change over the conversation, in place of the transcript. */
  open: (id: string) => void;
}

/**
 * The harness and the viewer, for the transcript's turns.
 *
 * Through context rather than down the tree: the transcript renders turns
 * inside folds inside runs, and the only thing at the bottom that needs either
 * is the one turn in five that changed something. Threading them through four
 * components to reach that row would put them in three signatures that have no
 * use for them.
 */
const ChangesContext = React.createContext<ChangesContextValue | null>(null);

export function ChangesProvider({
  harness,
  onOpen,
  children,
}: {
  harness: Harness;
  onOpen: (id: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = React.useMemo(() => ({ harness, open: onOpen }), [harness, onOpen]);
  return <ChangesContext.Provider value={value}>{children}</ChangesContext.Provider>;
}

function useOpenChange(): ((id: string) => void) | null {
  return React.useContext(ChangesContext)?.open ?? null;
}

/**
 * What a turn changed, under the turn.
 *
 * This used to hang off the operation row that caused it, which sounded right
 * and read terribly: the row is inside a run fold, inside the turn's
 * working-out fold, and the changes were behind a disclosure of their own — so
 * a diff was three clicks deep, and two of those clicks were on things that
 * say nothing about diffs. Every one of those folds exists to keep the
 * scrollback readable, and none of them should be able to hide the one part of
 * a turn the user is actually being asked to approve.
 *
 * So it sits at the top of the turn instead, next to the answer, where a pull
 * request would put its files. Nothing folds it away, and the diffs inside are
 * already open when there are few enough of them to read.
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
   * The turn's changes, live where they still are and stored where they are not.
   *
   * The live journal wins on a record they both hold: it is the one that knows
   * whether the change has since been put back. Everything else is read back
   * from the thread file — the same diff, minus the ability to revert it.
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span>{records.length === 1 ? "1 change" : `${records.length} changes`}</span>
        <Stats stats={sum(records)} />
        {allReverted && <span className="text-muted-foreground/70">· reverted</span>}
        {stale && (
          <Hint label="Putting a change back needs the Studio window it was made in. That session has ended, so this is here to read.">
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

      {/* Two is the point where opening everything stops being help. A turn
          that rewrote one script should show it without being asked; a turn
          that touched nine instances should show nine rows. */}
      <ChangeList
        records={records}
        harness={harness}
        outcomes={outcomes}
        onRevert={run}
        live={live}
        defaultOpen={records.length <= 2}
      />
    </div>
  );
}
