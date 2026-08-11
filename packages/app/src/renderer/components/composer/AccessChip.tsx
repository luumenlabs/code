/**
 * Permissions, where the user is actually deciding to act.
 *
 * These belong next to the send button, not parked in a sidebar: the question
 * "what is this agent allowed to do to my place" is asked at the moment you
 * send a message, and the answer has to be readable at a glance from the chip
 * itself.
 */
import * as React from "react";
import { Camera, ChevronDown, Eye, Gamepad2, MonitorPlay, Pencil, ShieldAlert, ShieldCheck, SquareTerminal } from "lucide-react";
import { PERMISSION_GROUPS, groupTally, isOp } from "@luumen/code-protocol";
import type { PermissionGroup, PermissionSettings, ToolPolicy } from "@luumen/code-protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const PERMISSIONS: Array<{ id: PermissionGroup; label: string; detail: string; icon: React.ElementType }> = [
  { id: "inspect", label: "Look around", detail: "Read your instances, scripts, and what the game is doing", icon: Eye },
  { id: "edit", label: "Change the place", detail: "Create, edit, and delete instances and scripts", icon: Pencil },
  { id: "playtest", label: "Playtest", detail: "Start and stop the game, and run its tests", icon: MonitorPlay },
  { id: "exec", label: "Run Luau", detail: "Run code inside your Studio session", icon: SquareTerminal },
  { id: "input", label: "Play the game", detail: "Click and type in the running game", icon: Gamepad2 },
  { id: "screenshot", label: "See your place", detail: "Screenshots, and pointing the Studio camera", icon: Camera },
];

/**
 * The groups, and nothing finer.
 *
 * Individual tools are deliberately not listed here. This chip is read in the
 * half second before pressing send, and its job is one glance at how much the
 * agent can do; fifty switches is a settings page, and it lives in Settings.
 * What the chip does have to do is stop claiming "Full access" when the user
 * has narrowed something — so a group with tools turned off inside it reads as
 * restricted, and the row says how many.
 */
export function AccessChip({
  permissions,
  disabledTools,
}: {
  permissions: PermissionSettings;
  disabledTools: string[];
}): React.JSX.Element {
  const policy: ToolPolicy = { permissions, disabledTools: disabledTools.filter(isOp) };

  const tallies = PERMISSION_GROUPS.map((group) => ({ group, ...groupTally(policy, group) }));
  const openGroups = tallies.filter((entry) => permissions[entry.group] !== false);
  const full = tallies.every((entry) => entry.allowed === entry.total);
  const none = tallies.every((entry) => entry.allowed === 0);

  const label = full ? "Full access" : none ? "No access" : `${openGroups.length} of ${PERMISSION_GROUPS.length}`;

  // Full access is the permissive state, so it is the one worth flagging.
  // Restricting the agent is the safe direction and reads as neutral.
  const tone = full ? "text-[var(--warning)]" : "text-muted-foreground";

  return (
    <Popover>
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

      <PopoverContent align="start" side="top" className="w-[300px] p-0">
        <div className="border-b px-3 py-2.5">
          <div className="text-[13.5px] font-medium">Agent access</div>
        </div>

        <div className="p-1">
          {PERMISSIONS.map(({ id, label: name, detail, icon: Icon }) => {
            const tally = tallies.find((entry) => entry.group === id);
            const narrowed = tally !== undefined && permissions[id] !== false && tally.allowed < tally.total;

            return (
              <label
                key={id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
              >
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[13px] leading-tight">{name}</span>
                    {/* Only shown when it is true, so the common case stays a
                        clean list rather than six identical counts. */}
                    {narrowed && (
                      <span className="text-[11px] leading-tight text-muted-foreground tabular-nums">
                        {tally.allowed}/{tally.total}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-tight text-muted-foreground">{detail}</span>
                </span>
                <Switch
                  className="mt-0.5"
                  checked={permissions[id] !== false}
                  onCheckedChange={(checked) => void window.luuCode.setPermission(id, checked)}
                />
              </label>
            );
          })}
        </div>

        {!full && (
          <div className="border-t px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Individual tools can be turned off under Settings → Permissions.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
