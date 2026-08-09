import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/misc";
import { AccessChip } from "@/components/composer/AccessChip";
import { AgentChip } from "@/components/composer/AgentChip";
import { ModelChip } from "@/components/composer/ModelChip";
import { OptionsChip } from "@/components/composer/OptionsChip";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

const MAX_HEIGHT = 220;

export function Composer({
  harness,
  value,
  onValueChange,
}: {
  harness: Harness;
  value: string;
  onValueChange: (value: string) => void;
}): React.JSX.Element {
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = React.useState(false);

  const snapshot = harness.snapshot;
  const session = snapshot?.session;
  const studioConnected = (snapshot?.status.sessions.length ?? 0) > 0;
  const agentReady = session != null && session.state !== "stopped" && session.state !== "error";

  // A conversation is filed against a Roblox place, so there is nowhere to put
  // one until Studio is connected.
  const ready = agentReady && studioConnected;

  const placeholder = !studioConnected
    ? "Connect Roblox Studio to start a conversation."
    : agentReady
      ? "Describe a change to your Roblox experience…"
      : "Choose a coding agent below to start.";

  React.useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (text.length === 0 || !ready) return;
    onValueChange("");
    await harness.send(text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pt-1 pb-4">
      <div className="mx-auto max-w-[860px]">
        <div
          className={cn(
            "rounded-xl border bg-card shadow-sm transition-colors",
            focused ? "border-primary/50" : "border-border",
          )}
        >
          <div className="px-3.5 pt-3 pb-1">
            <Textarea
              ref={textarea}
              rows={1}
              value={value}
              disabled={!ready}
              placeholder={placeholder}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </div>

          <div className="flex items-center gap-0.5 px-2 pt-0.5 pb-2">
            <AgentChip harness={harness} />
            <ModelChip
              agent={session?.agent ?? null}
              selection={harness.modelSelection}
              onChange={harness.setModelSelection}
            />
            <OptionsChip selection={harness.modelSelection} onChange={harness.setModelSelection} />
            {snapshot && <AccessChip permissions={snapshot.capabilities.permissions} />}

            <span className="flex-1" />

            {harness.busy ? (
              <Button size="icon-sm" variant="secondary" onClick={() => void harness.interrupt()} title="Stop">
                <Square className="size-3" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                className="rounded-full"
                onClick={() => void submit()}
                disabled={!ready || value.trim().length === 0}
                title="Send"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
