/**
 * What was done to the place, and the button that takes it back.
 *
 * Grouped by instance rather than listed by time. A session's changes read as
 * fifteen indistinguishable lines when they are a timeline, and as "three things
 * happened to the Shop" when they are grouped — and the instance is what the
 * user is deciding about anyway.
 *
 * The same list appears in two widths: the dock, where it is the session's whole
 * history, and under an edit row in the transcript, where it is what that one
 * operation did. Both use the components below so a change looks the same and
 * reverts the same wherever it is read.
 */
import * as React from "react";
import {
  ChevronRight,
  CircleAlert,
  Columns2,
  FilePlus2,
  FileCode2,
  Loader2,
  Maximize2,
  Move,
  Pencil,
  Rows2,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ChangeRecord, RevertOutcome } from "@luumen/code-protocol";
import { groupChanges, isPending } from "@luumen/code-protocol";
import { ChangeDiff } from "@/components/ChangeDiff";
import { hasDocument } from "@/components/changeDocument";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
// The dock panel
// ---------------------------------------------------------------------------

export function ChangesTab({ harness }: { harness: Harness }): React.JSX.Element {
  const { outcomes, run } = useRevert(harness);
  const groups = React.useMemo(() => groupChanges(harness.changes), [harness.changes]);
  const pending = React.useMemo(() => harness.changes.filter(isPending), [harness.changes]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2.5 py-2">
        <span className="text-[12px] text-muted-foreground">
          {harness.changes.length === 0 ? "" : `${pending.length} of ${harness.changes.length} applied`}
        </span>

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
 * No instance grouping: the operation above it already named what it touched,
 * and a heading repeating that would be a heading saying nothing.
 */
export function ChangeList({ records, harness }: { records: ChangeRecord[]; harness: Harness }): React.JSX.Element {
  const { outcomes, run } = useRevert(harness);

  return (
    <div className="flex flex-col rounded-lg border bg-card/40">
      {records.map((record) => (
        <ChangeRow
          key={record.id}
          record={record}
          harness={harness}
          outcome={outcomes[record.id]}
          onRevert={run}
          showPath={records.length > 1}
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
  showPath,
}: {
  record: ChangeRecord;
  harness: Harness;
  outcome: RevertOutcome | undefined;
  onRevert: (records: ChangeRecord[], force?: boolean) => Promise<void>;
  showPath?: boolean;
}): React.JSX.Element {
  const Icon = KIND_ICON[record.kind];
  const reverted = !isPending(record);
  const busy = harness.reverting.includes(record.id);
  const [expanded, setExpanded] = React.useState(false);
  // Cheap: whether there is a document, not what the diff of it looks like.
  // The diffing itself happens in ChangeDiff, and only once the row is open.
  const detail = React.useMemo(() => hasDocument(record), [record]);

  const body = (
    <div className="flex items-start gap-2 px-2.5 py-1.5">
      <Icon className={cn("mt-[3px] size-3.5 shrink-0", reverted ? "text-muted-foreground/50" : "text-violet-400/90")} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {detail && (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/change:rotate-90" />
          )}
          <span
            className={cn(
              "selectable min-w-0 flex-1 truncate text-left text-[12.5px]",
              reverted && "text-muted-foreground line-through",
            )}
          >
            {record.summary}
          </span>
        </div>

        {showPath && (
          <code className="block truncate font-mono text-[11px] text-muted-foreground/70">{record.target.path}</code>
        )}
      </div>

      {busy ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : reverted ? (
        <span className="mt-px shrink-0 text-[11px] text-muted-foreground/70">Reverted</span>
      ) : null}
    </div>
  );

  return (
    <div className="border-t first:border-t-0">
      {detail ? (
        <Collapsible className="group/change">
          <CollapsibleTrigger className="w-full text-left transition-colors hover:bg-accent/40">{body}</CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-2.5 pb-2 pl-[30px]">
              <ChangeDetail record={record} onExpand={() => setExpanded(true)} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        body
      )}

      <RowFooter record={record} harness={harness} outcome={outcome} onRevert={onRevert} />

      <ExpandedDiff record={record} open={expanded} onOpenChange={setExpanded} />
    </div>
  );
}

/**
 * The revert control, and whatever the last attempt had to say.
 *
 * A change that cannot go back gets the reason instead of a disabled button:
 * a button you cannot press tells you nothing about why, and "Archivable is off
 * on this instance" is the whole answer.
 */
function RowFooter({
  record,
  harness,
  outcome,
  onRevert,
}: {
  record: ChangeRecord;
  harness: Harness;
  outcome: RevertOutcome | undefined;
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

  const busy = harness.reverting.includes(record.id);

  return (
    <div className="flex items-start gap-2 px-2.5 pb-2 pl-[30px]">
      {outcome ? (
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "flex items-start gap-1.5 text-[11.5px] leading-relaxed",
              outcome.status === "conflict" ? "text-[var(--warning)]" : "text-destructive",
            )}
          >
            <CircleAlert className="mt-px size-3 shrink-0" />
            <span className="selectable">{outcome.reason ?? "It could not be put back."}</span>
          </p>
          {outcome.current && (
            <p className="pl-[18px] text-[11px] text-muted-foreground">Now: {outcome.current}</p>
          )}
          {/* Only a conflict is worth overriding. A failure is Roblox refusing
              the write, and asking again harder does not change that. */}
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
      ) : (
        <button
          type="button"
          disabled={busy || harness.reverting.length > 0}
          onClick={() => void onRevert([record])}
          className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Undo2 className="size-3" />
          Revert
        </button>
      )}
    </div>
  );
}

/**
 * The diff over the conversation, with room to read it.
 *
 * Split is the default here and only here: two columns need width, and the
 * width is the whole reason this exists. The dock keeps the unified view, which
 * is the one that survives a narrow column.
 */
function ExpandedDiff({
  record,
  open,
  onOpenChange,
}: {
  record: ChangeRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [split, setSplit] = React.useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] w-[min(1400px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px]">{record.summary}</DialogTitle>
            <code className="selectable block truncate font-mono text-[11.5px] text-muted-foreground">
              {record.target.path}
            </code>
          </div>

          <Hint label={split ? "Unified" : "Side by side"}>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => setSplit((value) => !value)}>
              {split ? <Rows2 /> : <Columns2 />}
            </Button>
          </Hint>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* Mounted only while open, so a large script is not diffed and
              highlighted for every row in a list nobody has opened. */}
          {open && <ChangeDiff record={record} split={split} className="border-0" />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A change's own diff, plus the way out to a bigger one.
 *
 * The dock is narrow by design, and a script diff read through a 340px column
 * is a diff you scroll rather than read. The expand button opens the same
 * record over the conversation, where there is room for two columns.
 */
function ChangeDetail({
  record,
  onExpand,
}: {
  record: ChangeRecord;
  onExpand: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-[340px] overflow-auto rounded-md">
        <ChangeDiff record={record} />
      </div>

      <button
        type="button"
        onClick={onExpand}
        className="flex items-center gap-1 self-start text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Maximize2 className="size-3" />
        Open
      </button>
    </div>
  );
}
// ---------------------------------------------------------------------------
// In the transcript
// ---------------------------------------------------------------------------

/**
 * The harness, for the transcript's activity rows.
 *
 * Through context rather than down the tree: the transcript renders turns
 * inside folds inside runs, and the only thing at the bottom that needs the
 * harness is the one row in five that changed something. Threading it through
 * four components to reach that row would put it in three signatures that have
 * no use for it.
 */
const HarnessContext = React.createContext<Harness | null>(null);

export function ChangesProvider({
  harness,
  children,
}: {
  harness: Harness;
  children: React.ReactNode;
}): React.JSX.Element {
  return <HarnessContext.Provider value={harness}>{children}</HarnessContext.Provider>;
}

/**
 * What one operation changed, folded under the row that reports it.
 *
 * Collapsed by default. A turn that edits nine things would otherwise open into
 * nine diffs, and the transcript is for reading what happened, not for
 * reviewing it line by line — that is what the dock is.
 */
export function ActivityChanges({ activityId }: { activityId: string }): React.JSX.Element | null {
  const harness = React.useContext(HarnessContext);
  const records = React.useMemo(
    () => (harness ? harness.changes.filter((record) => record.activityId === activityId) : []),
    [harness, activityId],
  );

  if (!harness || records.length === 0) return null;

  const standing = records.filter(isPending).length;

  return (
    <Collapsible className="mt-1.5 pl-[22px]">
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {records.length === 1 ? "1 change" : `${records.length} changes`}
        {standing === 0 && <span className="text-muted-foreground/70">· reverted</span>}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1.5">
          <ChangeList records={records} harness={harness} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
