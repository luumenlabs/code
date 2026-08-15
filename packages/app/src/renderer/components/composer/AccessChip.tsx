/** Permissions, next to the send button and readable off the chip. */
import * as React from "react";
import {
  Camera,
  ChevronDown,
  Eye,
  Gamepad2,
  MonitorPlay,
  Pencil,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Store,
} from "lucide-react";
import { PERMISSION_GROUPS, groupTally, isOp } from "@luumen/code-protocol";
import type { PermissionGroup, PermissionSettings, ToolPolicy } from "@luumen/code-protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const PERMISSIONS: Array<{ id: PermissionGroup; label: string; detail: string; icon: React.ElementType }> = [
  { id: "inspect", label: "Look around", detail: "Read instances, scripts, and runtime state", icon: Eye },
  { id: "edit", label: "Change the place", detail: "Create, edit, and delete", icon: Pencil },
  { id: "playtest", label: "Playtest", detail: "Start, stop, and run tests", icon: MonitorPlay },
  { id: "exec", label: "Run Luau", detail: "Execute code in your session", icon: SquareTerminal },
  { id: "input", label: "Play the game", detail: "Click and type in the running game", icon: Gamepad2 },
  { id: "screenshot", label: "See your place", detail: "Screenshots and camera", icon: Camera },
  { id: "assets", label: "Use the store", detail: "Search the Creator Store and insert assets", icon: Store },
];

export function AccessChip({
  permissions,
  disabledTools,
  onOpenAdvanced,
}: {
  permissions: PermissionSettings;
  disabledTools: string[];
  onOpenAdvanced: () => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const policy: ToolPolicy = { permissions, disabledTools: disabledTools.filter(isOp) };

  const tallies = PERMISSION_GROUPS.map((group) => ({ group, ...groupTally(policy, group) }));
  const openGroups = tallies.filter((entry) => permissions[entry.group] !== false);
  const full = tallies.every((entry) => entry.allowed === entry.total);
  const none = tallies.every((entry) => entry.allowed === 0);

  const label = full ? "Full access" : none ? "No access" : `${openGroups.length} of ${PERMISSION_GROUPS.length}`;

  // Full access is the permissive state, so it is the one worth flagging.
  const tone = full ? "text-[var(--warning)]" : "text-muted-foreground";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring/60",
          tone,
        )}
      >
        {full ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[290px] p-0">
        <div className="flex items-center justify-between gap-2 border-b py-1.5 pl-3 pr-1.5">
          <span className="text-[13px] font-medium">Agent access</span>
          {/* Closed by hand: Settings replaces the view behind it. */}
          <button
            onClick={() => {
              setOpen(false);
              onOpenAdvanced();
            }}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <SlidersHorizontal className="size-3" />
            Advanced
          </button>
        </div>

        <div className="p-1">
          {PERMISSIONS.map(({ id, label: name, detail, icon: Icon }) => {
            const tally = tallies.find((entry) => entry.group === id);
            const on = permissions[id] !== false;

            return (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-tight">{name}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-tight text-muted-foreground">{detail}</span>
                </span>
                {/* How many tools of the group are live, so one narrowed under
                    Advanced does not read as fully on. */}
                <span
                  className={cn(
                    "shrink-0 text-[11px] tabular-nums",
                    on && tally && tally.allowed < tally.total ? "text-[var(--warning)]" : "text-muted-foreground/60",
                  )}
                >
                  {tally?.allowed ?? 0}/{tally?.total ?? 0}
                </span>
                <Switch
                  className="shrink-0"
                  checked={on}
                  onCheckedChange={(checked) => void window.luuCode.setPermission(id, checked)}
                />
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
