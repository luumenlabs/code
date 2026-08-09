/**
 * Permissions, where the user is actually deciding to act. Spec sections 25 and 26.
 *
 * These belong next to the send button, not parked in a sidebar: the question
 * "what is this agent allowed to do to my place" is asked at the moment you
 * send a message, and the answer has to be readable at a glance from the chip
 * itself.
 */
import * as React from "react";
import { Camera, ChevronDown, Eye, Gamepad2, MonitorPlay, Pencil, ShieldAlert, ShieldCheck, SquareTerminal } from "lucide-react";
import { PERMISSION_GROUPS } from "@luumen/code-protocol";
import type { PermissionGroup, PermissionSettings } from "@luumen/code-protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const PERMISSIONS: Array<{ id: PermissionGroup; label: string; detail: string; icon: React.ElementType }> = [
  { id: "inspect", label: "Inspect Studio", detail: "Read the DataModel, scripts, and runtime state", icon: Eye },
  { id: "edit", label: "Edit the place", detail: "Create, change, and delete instances and scripts", icon: Pencil },
  { id: "playtest", label: "Playtest", detail: "Start and stop the game", icon: MonitorPlay },
  { id: "exec", label: "Run Luau", detail: "Execute code inside your Studio session", icon: SquareTerminal },
  { id: "input", label: "Send input", detail: "Click and type in the running game", icon: Gamepad2 },
  { id: "screenshot", label: "Screenshots", detail: "Capture the Studio window", icon: Camera },
];

export function AccessChip({ permissions }: { permissions: PermissionSettings }): React.JSX.Element {
  const allowed = PERMISSION_GROUPS.filter((group) => permissions[group] !== false);
  const full = allowed.length === PERMISSION_GROUPS.length;
  const none = allowed.length === 0;

  const label = full ? "Full access" : none ? "No access" : `${allowed.length} of ${PERMISSION_GROUPS.length} allowed`;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring/60",
          full ? "text-muted-foreground" : "text-[var(--warning)]",
        )}
      >
        {full ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[300px] p-0">
        <div className="border-b px-3 py-2.5">
          <div className="text-[12.5px] font-medium">Agent access</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            What the agent may do to the connected place.
          </p>
        </div>

        <div className="p-1">
          {PERMISSIONS.map(({ id, label: name, detail, icon: Icon }) => (
            <label
              key={id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
            >
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] leading-tight">{name}</span>
                <span className="mt-0.5 block text-[10.5px] leading-tight text-muted-foreground">{detail}</span>
              </span>
              <Switch
                className="mt-0.5"
                checked={permissions[id] !== false}
                onCheckedChange={(checked) => void window.luuCode.setPermission(id, checked)}
              />
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
