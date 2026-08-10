import * as React from "react";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHarness } from "@/state";

export function App(): React.JSX.Element {
  const harness = useHarness();
  const [draft, setDraft] = React.useState("");
  const [dockOpen, setDockOpen] = React.useState(true);
  const [dockTab, setDockTab] = React.useState<DockTab>("studio");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsSection, setSettingsSection] = React.useState<Section>("general");

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
      <div className="flex h-full flex-col">
        <TitleBar
          harness={harness}
          dockOpen={dockOpen}
          dockVisible={dockOpen && !settingsOpen}
          onToggleDock={() => setDockOpen((open) => !open)}
          dockTab={dockTab}
          onDockTabChange={setDockTab}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar
            harness={harness}
            onSearch={() => setPaletteOpen(true)}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((open) => !open)}
            onExitSettings={() => setSettingsOpen(false)}
            onOpenUpdates={() => {
              setSettingsSection("updates");
              setSettingsOpen(true);
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

              {dockOpen && <RightDock harness={harness} tab={dockTab} />}
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
    </TooltipProvider>
  );
}
