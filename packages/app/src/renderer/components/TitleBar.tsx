/**
 * The window chrome doubles as the Studio status bar.
 *
 * Whether Studio is connected, and whether it is running, is the single most
 * important thing on screen: almost every failure the agent can hit traces back
 * to one of them. Spec section 8.
 */
import { CirclePlay, Loader2, PanelRight, Play, Square, Unplug } from "lucide-react";
import { Wordmark } from "@/components/Brand";
import { DockTabs } from "@/components/RightDock";
import type { DockTab } from "@/components/RightDock";
import { WindowControls } from "@/components/WindowControls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export function TitleBar({
  harness,
  dockOpen,
  dockVisible,
  onToggleDock,
  dockTab,
  onDockTabChange,
}: {
  harness: Harness;
  dockOpen: boolean;
  /**
   * Whether the dock is actually on screen, which is not the same as open:
   * settings replaces the chat and the dock together, and a strip of dock
   * colour over a panel that is not there is worse than none.
   */
  dockVisible: boolean;
  onToggleDock: () => void;
  /** The dock's switcher lives up here; the panel below opens on its content. */
  dockTab: DockTab;
  onDockTabChange: (tab: DockTab) => void;
}): React.JSX.Element {
  const snapshot = harness.snapshot;
  const session = snapshot?.status.sessions.find((entry) => entry.active) ?? snapshot?.status.sessions[0] ?? null;
  const running = session?.run.running ?? false;
  const errors = harness.output.filter((entry) => entry.type === "error").length;
  const platform = snapshot?.platform ?? "win32";

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
        className={cn(
          "flex w-sidebar shrink-0 items-center gap-3 border-r border-sidebar-border bg-sidebar",
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

      <div className={cn("relative flex min-w-0 flex-1 items-center gap-3 pl-3", platform === "darwin" && "pr-3")}>
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

        {!dockVisible && <WindowControls platform={platform} />}
      </div>

      {/*
        The dock's own column, run to the top of the window.

        Same reason as the sidebar segment: a panel whose surface starts below
        the title bar reads as a block floating in the window rather than as a
        column of it. It carries the dock's switcher, so the row is doing work
        rather than being a band of empty panel above the tabs.
      */}
      {dockVisible && (
        <div className="flex w-dock shrink-0 items-center gap-2 border-l border-sidebar-border bg-sidebar pl-2">
          <div className="no-drag">
            <DockTabs tab={dockTab} onTabChange={onDockTabChange} errors={errors} />
          </div>

          <span className="flex-1" />

          <WindowControls platform={platform} />
        </div>
      )}
    </header>
  );
}
