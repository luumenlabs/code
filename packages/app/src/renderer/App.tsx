import * as React from "react";
import { ChangesProvider } from "@/components/Changes";
import { ChangeViewer } from "@/components/ChangeViewer";
import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/Composer";
import { PairingDialog } from "@/components/PairingDialog";
import { RightDock } from "@/components/RightDock";
import type { DockTab } from "@/components/RightDock";
import { SettingsView } from "@/components/settings/SettingsView";
import type { Section } from "@/components/settings/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { TitleBar } from "@/components/TitleBar";
import { Transcript } from "@/components/Transcript";
import { Resizer } from "@/components/ui/resizer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PANEL_BOUNDS, clampPanel, fitPanels } from "../shared/settings.js";
import { useHarness } from "@/state";

export function App(): React.JSX.Element {
  const harness = useHarness();
  const [draft, setDraft] = React.useState("");
  const [dockOpen, setDockOpen] = React.useState(true);
  const [dockTab, setDockTab] = React.useState<DockTab>("studio");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsSection, setSettingsSection] = React.useState<Section>("general");
  /**
   * The change being read in place of the chat, by id rather than by record.
   *
   * By id because the record is not the app's to hold: it is reverted, the
   * thread is switched, the journal is reloaded — and a copy kept here would go
   * on showing a change that is no longer in it. Looking it up each render
   * means the viewer closes by itself when the thing it was showing is gone.
   */
  const [viewing, setViewing] = React.useState<string | null>(null);

  // Ctrl/Cmd+K opens the palette, Ctrl/Cmd+N starts a conversation.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;

      if (event.key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "n") {
        event.preventDefault();
        setSettingsOpen(false);
        void harness.newThread();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [harness]);

  /**
   * Panel widths, live while dragging and stored once it stops.
   *
   * Local state drives the layout so a drag is smooth; the settings write only
   * happens on release, because a settings file rewritten sixty times a second
   * is a settings file that eventually loses.
   */
  const stored = harness.settings.layout;
  const [sidebarWidth, setSidebarWidth] = React.useState(stored.sidebarWidth);
  const [dockWidth, setDockWidth] = React.useState(stored.dockWidth);
  const dragging = React.useRef(false);

  // Settings arrive after the first render, and can change from another window.
  // Ignored mid-drag, so an echo of a value we just wrote cannot fight the
  // pointer.
  React.useEffect(() => {
    if (dragging.current) return;
    setSidebarWidth(stored.sidebarWidth);
    setDockWidth(stored.dockWidth);
  }, [stored.sidebarWidth, stored.dockWidth]);

  /**
   * The row the three panes live in, measured.
   *
   * A stored width is what the user asked for on whatever window they asked it
   * on; what fits is a question only this window can answer, and it changes
   * every time the window is resized.
   */
  const row = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState(0);

  React.useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;

    setAvailable(element.clientWidth);
    const observer = new ResizeObserver((entries) => setAvailable(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const showDock = dockOpen && !settingsOpen;
  const fitted = fitPanels({ available, sidebar: sidebarWidth, dock: showDock ? dockWidth : 0 });

  // The live journal first, because it is the copy that knows whether the
  // change has since been put back; the thread's own history behind it, so a
  // diff stays readable after the Studio window that made it has gone.
  const viewed = viewing
    ? (harness.changes.find((record) => record.id === viewing) ??
      harness.history.find((record) => record.id === viewing) ??
      null)
    : null;
  const viewedIsLive = viewed !== null && harness.changes.some((record) => record.id === viewed.id);

  const sessions = harness.snapshot?.status.sessions ?? [];
  const place = sessions.find((entry) => entry.active) ?? sessions[0] ?? null;

  // The first runtime error is worth interrupting for: it is usually the thing
  // the agent is about to react to, and the user wants to see it too.
  const errorCount = harness.output.filter((entry) => entry.type === "error").length;
  const lastErrorCount = React.useRef(errorCount);

  React.useEffect(() => {
    if (!harness.settings.followRuntimeErrors) return;
    if (errorCount > lastErrorCount.current && dockOpen) setDockTab("output");
    lastErrorCount.current = errorCount;
  }, [errorCount, dockOpen, harness.settings.followRuntimeErrors]);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      {/* A turn's diffs sit four components deep inside folds that have no use
          for the harness, and the button that opens one over the chat is deeper
          still. */}
      <ChangesProvider harness={harness} onOpen={setViewing}>
        <div className="flex h-full flex-col">
          <TitleBar
            harness={harness}
            sidebarWidth={fitted.sidebar}
            dockWidth={fitted.dock}
            dockOpen={dockOpen}
            dockVisible={showDock}
            onToggleDock={() => setDockOpen((open) => !open)}
          />

          <div ref={row} className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar
              harness={harness}
              width={fitted.sidebar}
              onSearch={() => setPaletteOpen(true)}
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              onExitSettings={() => setSettingsOpen(false)}
              onOpenUpdates={() => {
                setSettingsSection("updates");
                setSettingsOpen(true);
              }}
            />

            <Resizer
              side="left"
              label="Resize the sidebar"
              width={fitted.sidebar}
              min={PANEL_BOUNDS.sidebar.min}
              max={PANEL_BOUNDS.sidebar.max}
              onChange={(next) => {
                dragging.current = true;
                setSidebarWidth(next);
              }}
              onCommit={(next) => {
                dragging.current = false;
                harness.updateSettings({ layout: { ...stored, sidebarWidth: clampPanel(next, PANEL_BOUNDS.sidebar) } });
              }}
            />

            {settingsOpen ? (
              <SettingsView
                harness={harness}
                section={settingsSection}
                onSectionChange={setSettingsSection}
                onClose={() => setSettingsOpen(false)}
              />
            ) : (
              <>
                {viewed ? (
                  <ChangeViewer
                    record={viewed}
                    harness={harness}
                    live={viewedIsLive}
                    onClose={() => setViewing(null)}
                  />
                ) : (
                  <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <Transcript
                      items={harness.timeline}
                      onExample={setDraft}
                      showThinking={harness.settings.showThinking}
                      placeName={place?.place.name ?? null}
                      busy={harness.busy}
                      state={harness.snapshot?.session.state}
                    />
                    <Composer harness={harness} value={draft} onValueChange={setDraft} />
                  </main>
                )}

                {dockOpen && (
                <>
                  <Resizer
                    side="right"
                    label="Resize the panel"
                    width={fitted.dock}
                    min={PANEL_BOUNDS.dock.min}
                    max={PANEL_BOUNDS.dock.max}
                    onChange={(next) => {
                      dragging.current = true;
                      setDockWidth(next);
                    }}
                    onCommit={(next) => {
                      dragging.current = false;
                      harness.updateSettings({ layout: { ...stored, dockWidth: clampPanel(next, PANEL_BOUNDS.dock) } });
                    }}
                  />
                  <RightDock harness={harness} width={fitted.dock} tab={dockTab} onTabChange={setDockTab} />
                </>
              )}
              </>
            )}
          </div>
        </div>

        <CommandPalette
          harness={harness}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onExitSettings={() => setSettingsOpen(false)}
        />
        <PairingDialog request={harness.pendingPairing} />
      </ChangesProvider>
    </TooltipProvider>
  );
}
