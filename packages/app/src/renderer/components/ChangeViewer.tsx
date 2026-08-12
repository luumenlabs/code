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
import { ArrowLeft, Columns2, History, Loader2, Rows2, Undo2 } from "lucide-react";
import { isPending } from "@luumen/code-protocol";
import { ChangeDiff } from "@/components/ChangeDiff";
import { bundleLabel, bundleStats } from "@/components/changeDocument";
import type { ChangeBundle } from "@/components/changeDocument";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export function ChangeViewer({
  bundle,
  harness,
  live,
  onClose,
}: {
  /** The row's whole run of operations, so this shows the diff it showed. */
  bundle: ChangeBundle;
  harness: Harness;
  /**
   * Whether the Studio window that made this is still connected.
   *
   * False for a change read back from the thread file. The diff is the same
   * document either way — reverting is the part that needs a live DataModel to
   * write back into and a copy of the subtree to write.
   */
  live: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [split, setSplit] = React.useState(true);

  const records = bundle.records;
  // The newest carries the path the instance is at now, and the sentence for
  // the last thing done to it.
  const record = records[records.length - 1]!;
  const pending = records.filter(isPending);

  const label = bundleLabel(bundle);
  const stats = bundleStats(bundle);
  const reverted = pending.length === 0;
  const busy = records.some((entry) => harness.reverting.includes(entry.id));

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
        ) : !live ? (
          <Hint label="Putting a change back needs the Studio window it was made in. That session has ended, so this is here to read.">
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
              <History className="size-3.5" />
              Earlier session
            </span>
          </Hint>
        ) : pending.every((entry) => entry.revertable) ? (
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            disabled={busy || harness.reverting.length > 0}
            // Every operation behind the diff, newest first — the same thing
            // the row's own button does.
            onClick={() => void harness.revert(pending.map((entry) => entry.id))}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Revert
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ChangeDiff bundle={bundle} split={split} className="border-0" />
      </div>
    </main>
  );
}
