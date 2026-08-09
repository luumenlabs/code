import * as React from "react";
import { Composer } from "@/components/Composer";
import { PairingDialog } from "@/components/PairingDialog";
import { RightDock } from "@/components/RightDock";
import type { DockTab } from "@/components/RightDock";
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

  // The first runtime error is worth interrupting for: it is usually the thing
  // the agent is about to react to, and the user wants to see it too.
  const errorCount = harness.output.filter((entry) => entry.type === "error").length;
  const lastErrorCount = React.useRef(errorCount);

  React.useEffect(() => {
    if (errorCount > lastErrorCount.current && dockOpen) setDockTab("output");
    lastErrorCount.current = errorCount;
  }, [errorCount, dockOpen]);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className="flex h-full flex-col">
        <TitleBar harness={harness} dockOpen={dockOpen} onToggleDock={() => setDockOpen((open) => !open)} />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar harness={harness} />

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Transcript items={harness.timeline} onExample={setDraft} />
            <Composer harness={harness} value={draft} onValueChange={setDraft} />
          </main>

          {dockOpen && <RightDock harness={harness} tab={dockTab} onTabChange={setDockTab} />}
        </div>
      </div>

      <PairingDialog request={harness.pendingPairing} />
    </TooltipProvider>
  );
}
