/**
 * One change, given the whole chat column.
 *
 * This was a modal. A modal is the wrong shape for reading a diff: it floats
 * over the conversation it came from at whatever size the viewport allowed,
 * dims the thing you are comparing it against, traps focus, and closes on the
 * stray Escape you meant for something else — all to show a document you want
 * to sit with. So it takes the chat's place instead, the way a file takes the
 * place of a diff list in every review tool, and the sidebar, the dock, and the
 * title bar stay exactly where they were. Going back is going back, not
 * dismissing.
 *
 * Split is the default here and only here: two columns need width, and the
 * width is the whole reason this exists. The rows in the transcript and the
 * dock keep the unified view, which is the one that survives a narrow column.
 */
import * as React from "react";
import { ArrowLeft, Columns2, Loader2, Rows2, Undo2 } from "lucide-react";
import type { ChangeRecord } from "@luumen/code-protocol";
import { isPending } from "@luumen/code-protocol";
import { ChangeDiff } from "@/components/ChangeDiff";
import { changeLabel, changeStats } from "@/components/changeDocument";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export function ChangeViewer({
  record,
  harness,
  onClose,
}: {
  record: ChangeRecord;
  harness: Harness;
  onClose: () => void;
}): React.JSX.Element {
  const [split, setSplit] = React.useState(true);
  const label = changeLabel(record);
  const stats = changeStats(record);
  const reverted = !isPending(record);
  const busy = harness.reverting.includes(record.id);

  // The one keyboard habit worth keeping from the dialog this replaced.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Hint label="Back to the chat">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClose}>
            <ArrowLeft />
          </Button>
        </Hint>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate font-mono text-[13px]", reverted && "text-muted-foreground line-through")}>
              {label.name}
            </span>
            {label.detail && (
              <span className="shrink-0 truncate font-mono text-[11.5px] text-muted-foreground/70">
                {label.detail}
              </span>
            )}
            {(stats.added > 0 || stats.removed > 0) && (
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] tabular-nums">
                {stats.added > 0 && <span className="text-[var(--success)]">+{stats.added}</span>}
                {stats.removed > 0 && <span className="text-destructive">−{stats.removed}</span>}
              </span>
            )}
          </div>
          {/* The sentence the plugin wrote, in the one place there is room for
              it: a header, once, rather than on forty rows. */}
          <div className="flex items-baseline gap-2 text-[11.5px] text-muted-foreground">
            <span className="shrink-0">{record.summary}</span>
            <code className="selectable min-w-0 truncate font-mono text-muted-foreground/70">
              {record.target.path}
            </code>
          </div>
        </div>

        <Hint label={split ? "Unified" : "Side by side"}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => setSplit((value) => !value)}
          >
            {split ? <Rows2 /> : <Columns2 />}
          </Button>
        </Hint>

        {reverted ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground/70">Reverted</span>
        ) : record.revertable ? (
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            disabled={busy || harness.reverting.length > 0}
            onClick={() => void harness.revert([record.id])}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Revert
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ChangeDiff record={record} split={split} className="border-0" />
      </div>
    </main>
  );
}
