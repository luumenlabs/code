/**
 * Which coding agent is answering, chosen where you send the message.
 *
 * Luu Code never asks for a model API key, so this is a list of the CLIs you
 * already have signed in, not a model picker. Spec sections 3.2 and 44.
 */
import * as React from "react";
import { Bot, Check, ChevronDown, CircleAlert, Loader2, Power } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";
import type { AgentId } from "../../../shared/agent.js";

export function AgentChip({ harness }: { harness: Harness }): React.JSX.Element | null {
  const snapshot = harness.snapshot;
  if (!snapshot) return null;

  const { agents, session } = snapshot;
  const current = agents.find((entry) => entry.id === session.agent);
  const thinking = session.state === "thinking" || session.state === "working" || session.state === "starting";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors outline-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60",
        )}
      >
        {thinking ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <Bot className="size-3.5" />}
        {current?.label ?? "Choose an agent"}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-[280px]">
        <DropdownMenuLabel>Coding agent</DropdownMenuLabel>

        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={!agent.installed}
            onSelect={() => void harness.startAgent(agent.id as AgentId)}
            className="items-start"
          >
            <Check className={cn("mt-0.5 size-3.5", session.agent === agent.id ? "opacity-100" : "opacity-0")} />
            <span className="min-w-0 flex-1">
              <span className="block">{agent.label}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground">
                {agent.installed ? (
                  (agent.version ?? "installed")
                ) : (
                  <>
                    <CircleAlert className="size-3" />
                    not installed
                  </>
                )}
              </span>
            </span>
          </DropdownMenuItem>
        ))}

        {agents.some((agent) => !agent.installed) && (
          <p className="px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            Luu Code uses the subscription you already have and never asks for a model API key.
          </p>
        )}

        {session.agent && session.state !== "stopped" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void harness.stopAgent()}>
              <Power />
              Stop agent
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

