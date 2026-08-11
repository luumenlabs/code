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
  sidebarWidth,
  dockWidth,
  dockOpen,
  dockVisible,
  onToggleDock,
}: {
  harness: Harness;
  /**
   * The widths the panels below actually got.
   *
   * The title bar carries a strip of each panel's colour up to the top of the
   * window, so the panel reads as a column rather than a block floating under a
   * bar. That only works if the strips are the same width as the panels — these
   * were fixed at the old CSS variables, so dragging a panel left its strip
   * behind and put a visible step in the divider.
   */
  sidebarWidth: number;
  dockWidth: number;
  dockOpen: boolean;
  /**
   * Whether the dock is actually on screen, which is not the same as open:
   * settings replaces the chat and the dock together, and a strip of dock
   * colour over a panel that is not there is worse than none.
   */
  dockVisible: boolean;
  onToggleDock: () => void;
}): React.JSX.Element {
  const snapshot = harness.snapshot;
  const session = snapshot?.status.sessions.find((entry) => entry.active) ?? snapshot?.status.sessions[0] ?? null;
  const running = session?.run.running ?? false;
  const errors = harness.output.filter((entry) => entry.type === "error").length;
  const platform = snapshot?.platform ?? "win32";

  // Built once and placed in whichever segment happens to be last, so the same
  // buttons land at the same distance from the window's right edge either way.
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
     * Two surfaces, not one strip.
     *
     * The bar used to be `bg-sidebar` across the whole window, which drew a
     * hard line above the conversation and made the app read as chrome over
     * content. Split at the sidebar's edge instead: the left runs the sidebar's
     * surface to the top of the window so the two are one panel, and the rest
     * is the chat's own background, so the conversation simply continues up.
     * No bottom border for the same reason — there is nothing to divide. The
     * dock gets the same treatment on the right, when it is open.
     */
    <header className="drag-region flex h-topbar shrink-0 items-stretch bg-background">
      <div
        style={{ width: sidebarWidth }}
        className={cn(
          "flex shrink-0 items-center gap-3 border-r border-sidebar-border bg-sidebar",
          // Room for the traffic lights, which macOS draws over this corner.
          platform === "darwin" ? "pl-[86px]" : "pl-3",
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
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3 pl-3">
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

        {!dockVisible && pinned}
      </div>

      {/*
        The dock's own column, run to the top of the window.

        Same reason as the sidebar segment: a panel whose surface starts below
        the title bar reads as a block floating in the window rather than as a
        column of it.
      */}
      {dockVisible && (
        <div
          style={{ width: dockWidth }}
          className="flex shrink-0 items-center justify-end border-l border-sidebar-border bg-sidebar"
        >
          {pinned}
        </div>
      )}
    </header>
  );
}

/**
 * The buttons that must not move, and the window's own.
 *
 * Play and the dock switch used to sit with the chat, which meant opening the
 * dock carried them left by the dock's width: you had to go and find the button
 * you had just pressed in order to press it again. Grouping them with the
 * window buttons fixes that without a hack, because whichever segment renders
 * last ends at the right edge of the window — so the cluster keeps the same
 * offset from that edge in both states and nothing in it moves.
 *
 * Play changes its own width when it becomes Stop, but only its left edge: what
 * is to the right of it is fixed, so the switch stays put through that too.
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
        // macOS keeps its traffic lights on the left, so the switch is the last
        // thing in the row and needs the edge inset itself.
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
