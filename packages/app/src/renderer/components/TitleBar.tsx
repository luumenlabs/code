/**
 * The window chrome doubles as the Studio status bar.
 *
 * Whether Studio is connected, and whether it is running, is the single most
 * important thing on screen: almost every failure the agent can hit traces back
 * to one of them. Spec section 8.
 */
import { CirclePlay, Loader2, PanelRight, Play, Square, Unplug } from "lucide-react";
import { Wordmark } from "@/components/Brand";
import { WindowControls } from "@/components/WindowControls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export function TitleBar({
  harness,
  dockOpen,
  onToggleDock,
}: {
  harness: Harness;
  dockOpen: boolean;
  onToggleDock: () => void;
}): React.JSX.Element {
  const snapshot = harness.snapshot;
  const session = snapshot?.status.sessions.find((entry) => entry.active) ?? snapshot?.status.sessions[0] ?? null;
  const running = session?.run.running ?? false;
  const errors = harness.output.filter((entry) => entry.type === "error").length;
  const platform = snapshot?.platform ?? "win32";

  return (
    <header
      className={cn(
        "drag-region flex h-topbar shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar pl-3",
        platform === "darwin" ? "pr-3 pl-[86px]" : "pr-0",
      )}
    >
      <Wordmark className="shrink-0" />

      {/* Release wears nothing; anything else says what it is, in its own
          colour, so two windows side by side are never mistaken for each
          other. */}
      {snapshot && snapshot.channel !== "release" && (
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-px text-[10.5px] font-semibold tracking-[0.08em] uppercase",
            snapshot.channel === "nightly"
              ? "border-[#a855f7]/40 bg-[#a855f7]/12 text-[#c084fc]"
              : "border-[#f59e0b]/40 bg-[#f59e0b]/12 text-[#fbbf24]",
          )}
        >
          {snapshot.channel === "nightly" ? "Nightly" : "Dev"}
        </span>
      )}

      <span className="h-4 w-px shrink-0 bg-border" />

      {session ? (
        // Only the playtest gets a badge. "Edit" is the resting state of every
        // Studio session, so labelling it said nothing and read like a button.
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium">{session.place.name}</span>
          {running && (
            <Badge variant="success">
              <CirclePlay className="size-3" />
              Playtest · {session.run.realm}
            </Badge>
          )}
        </div>
      ) : (
        <Badge variant="warning">
          <Unplug className="size-3" />
          Studio not connected
        </Badge>
      )}

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-1 pr-1">
        {/* The label is on the button; a tooltip repeating it is noise. */}
        {session &&
          (running ? (
            <Button variant="ghost" size="sm" onClick={() => void harness.run("run.stop")} disabled={harness.runBusy}>
              {harness.runBusy ? <Loader2 className="animate-spin" /> : <Square />}
              Stop
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void harness.run("run.start", { mode: "play" })}
              disabled={harness.runBusy}
            >
              {harness.runBusy ? <Loader2 className="animate-spin" /> : <Play />}
              Play
            </Button>
          ))}

        <Hint label="Studio panel">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleDock}
            className={cn("relative", dockOpen && "bg-accent text-foreground")}
          >
            <PanelRight />
            {!dockOpen && errors > 0 && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive" />
            )}
          </Button>
        </Hint>

      </div>

      <WindowControls platform={platform} />
    </header>
  );
}
