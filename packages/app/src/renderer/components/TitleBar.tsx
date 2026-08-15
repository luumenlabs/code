/**
 * The window chrome doubles as the Studio status bar: whether Studio is
 * connected, and whether it is running.
 */
import { Loader2, PanelRight, Play, Square, Unplug } from "lucide-react";
import { Wordmark } from "@/components/Brand";
import { WindowControls } from "@/components/WindowControls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export function TitleBar({
  harness,
  sidebarWidth,
  dockWidth,
  dockOpen,
  dockVisible,
  onToggleDock,
}: {
  harness: Harness;
  /**
   * The widths the panels below actually got. The title bar carries a strip of
   * each panel's colour to the top of the window, and the strips have to match
   * the panels or the divider shows a step.
   */
  sidebarWidth: number;
  dockWidth: number;
  dockOpen: boolean;
  /**
   * Whether the dock is on screen, which is not the same as open: settings
   * replaces the chat and the dock together.
   */
  dockVisible: boolean;
  onToggleDock: () => void;
}): React.JSX.Element {
  const snapshot = harness.snapshot;
  const session = snapshot?.status.sessions.find((entry) => entry.active) ?? snapshot?.status.sessions[0] ?? null;
  const running = session?.run.running ?? false;
  const errors = harness.output.filter((entry) => entry.type === "error").length;
  const platform = snapshot?.platform ?? "win32";

  // Built once and placed in whichever segment is last, so these keep the same
  // offset from the window's right edge either way.
  const pinned = (
    <Pinned platform={platform} dockOpen={dockOpen} onToggleDock={onToggleDock} errors={errors}>
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
    </Pinned>
  );

  return (
    /**
     * Two surfaces, not one strip: the left runs the sidebar's colour to the
     * top of the window, the rest is the chat's own background. No bottom
     * border — there is nothing to divide.
     *
     * Laid out the way the row below is: a segment of exactly the panel's
     * width, then a separate pixel of divider. A `border-r` sits inside the box
     * and lands one pixel off the `Resizer` under it.
     */
    <header className="drag-region flex h-topbar shrink-0 items-stretch bg-background">
      <div
        style={{ width: sidebarWidth }}
        className={cn(
          "flex shrink-0 items-center gap-3 bg-sidebar",
          // Room for the traffic lights, which macOS draws over this corner.
          platform === "darwin" ? "pl-[86px]" : "pl-3",
        )}
      >
        <Wordmark className="shrink-0" />

        {/* Release wears nothing; anything else says what it is, in its own
            colour. */}
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
      </div>

      {/* The sidebar's Resizer, continued to the top of the window. */}
      <div className="w-px shrink-0 bg-sidebar-border" />

      <div className="flex min-w-0 flex-1 items-center gap-3 pl-3">
        {session ? (
          // The place name and nothing else; the Studio panel carries the realm.
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{session.place.name}</span>
          </div>
        ) : (
          <Badge variant="warning">
            <Unplug className="size-3" />
            Studio not connected
          </Badge>
        )}

        <div className="flex-1" />

        {!dockVisible && pinned}
      </div>

      {/* The dock's own column, run to the top of the window. */}
      {dockVisible && (
        <>
          <div className="w-px shrink-0 bg-sidebar-border" />
          <div style={{ width: dockWidth }} className="flex shrink-0 items-center justify-end bg-sidebar">
            {pinned}
          </div>
        </>
      )}
    </header>
  );
}

/**
 * The buttons that must not move, and the window's own. Grouped with the window
 * controls so they keep the same offset from the right edge whether or not the
 * dock is open. Play changes width when it becomes Stop, on its left edge only.
 */
function Pinned({
  platform,
  dockOpen,
  onToggleDock,
  errors,
  children,
}: {
  platform: string;
  dockOpen: boolean;
  onToggleDock: () => void;
  /** Shown as a dot while the dock is shut, since the Output tab is out of sight. */
  errors: number;
  /** The app's own controls, to the left of the window's. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "no-drag flex items-center gap-1 self-stretch",
        // macOS keeps its traffic lights on the left, so the switch is last in
        // the row and needs the edge inset itself.
        platform === "darwin" && "pr-2",
      )}
    >
      {children}

      <Hint label="Studio panel">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleDock}
          className={cn("relative", dockOpen && "bg-accent text-foreground")}
        >
          <PanelRight />
          {!dockOpen && errors > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive" />}
        </Button>
      </Hint>

      <WindowControls platform={platform} />
    </div>
  );
}
