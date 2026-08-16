import * as React from "react";
import { ChangesProvider } from "@/components/Changes";
import { ChangeViewer } from "@/components/ChangeViewer";
import { bundleFrom } from "@/components/changeDocument";
import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/Composer";
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
   * The change being read in place of the chat, held as ids rather than
   * records: looked up each render, the viewer closes by itself once what it
   * was showing has gone. A list, because a row is every operation behind one
   * instance's change.
   */
  const [viewing, setViewing] = React.useState<string[] | null>(null);

  /*
    Stable, because the sidebar builds its row handlers out of these and the
    rows are memoised. An inline arrow here would rebuild them on every render
    and the memo would never hold.
  */
  const openPalette = React.useCallback(() => setPaletteOpen(true), []);
  const exitSettings = React.useCallback(() => setSettingsOpen(false), []);
  const enterSettings = React.useCallback(() => setSettingsOpen(true), []);
  const toggleSettings = React.useCallback(() => setSettingsOpen((open) => !open), []);
  const toggleDock = React.useCallback(() => setDockOpen((open) => !open), []);

  const openUpdates = React.useCallback(() => {
    setSettingsSection("updates");
    setSettingsOpen(true);
  }, []);

  const openPermissions = React.useCallback(() => {
    setSettingsSection("permissions");
    setSettingsOpen(true);
  }, []);

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
   * Panel widths, live while dragging and stored once it stops. Local state
   * drives the layout so the drag is smooth; the settings write is on release.
   */
  const stored = harness.settings.layout;
  const [sidebarWidth, setSidebarWidth] = React.useState(stored.sidebarWidth);
  const [dockWidth, setDockWidth] = React.useState(stored.dockWidth);
  const dragging = React.useRef(false);

  // Settings arrive after the first render. Ignored mid-drag, so an echo of a
  // value just written cannot fight the pointer.
  React.useEffect(() => {
    if (dragging.current) return;
    setSidebarWidth(stored.sidebarWidth);
    setDockWidth(stored.dockWidth);
  }, [stored.sidebarWidth, stored.dockWidth]);

  /**
   * The row the three panes live in, measured. A stored width is what the user
   * asked for; what fits is a question only this window can answer.
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

  // The live journal first — it knows whether the change has since been put
  // back — then the thread's stored history.
  const viewedRecords = (viewing ?? []).flatMap((id) => {
    const record = harness.changes.find((entry) => entry.id === id) ?? harness.history.find((entry) => entry.id === id);
    return record ? [record] : [];
  });

  const viewed = bundleFrom(viewedRecords);
  // Reverting needs the window that made it, so one record missing from the
  // journal makes the whole row unrevertable.
  const viewedIsLive =
    viewed !== null && viewedRecords.every((record) => harness.changes.some((entry) => entry.id === record.id));

  const sessions = harness.snapshot?.status.sessions ?? [];
  const place = sessions.find((entry) => entry.active) ?? sessions[0] ?? null;

  // A new runtime error is usually what the agent is about to react to.
  const errorCount = harness.output.filter((entry) => entry.type === "error").length;
  const lastErrorCount = React.useRef(errorCount);

  React.useEffect(() => {
    if (!harness.settings.followRuntimeErrors) return;
    if (errorCount > lastErrorCount.current && dockOpen) setDockTab("output");
    lastErrorCount.current = errorCount;
  }, [errorCount, dockOpen, harness.settings.followRuntimeErrors]);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      {/* A turn's diffs sit four components deep, inside folds with no use for
          the harness. */}
      <ChangesProvider harness={harness} onOpen={setViewing}>
        <div className="flex h-full flex-col">
          <TitleBar
            harness={harness}
            sidebarWidth={fitted.sidebar}
            dockWidth={fitted.dock}
            dockOpen={dockOpen}
            dockVisible={showDock}
            onToggleDock={toggleDock}
          />

          <div ref={row} className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar
              harness={harness}
              width={fitted.sidebar}
              onSearch={openPalette}
              settingsOpen={settingsOpen}
              onToggleSettings={toggleSettings}
              onExitSettings={exitSettings}
              onOpenUpdates={openUpdates}
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
                onClose={exitSettings}
              />
            ) : (
              <>
                {viewed ? (
                  <ChangeViewer
                    bundle={viewed}
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
                    <Composer
                      harness={harness}
                      value={draft}
                      onValueChange={setDraft}
                      onOpenPermissions={openPermissions}
                    />
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
          onOpenSettings={enterSettings}
          onExitSettings={exitSettings}
        />
      </ChangesProvider>
    </TooltipProvider>
  );
}
