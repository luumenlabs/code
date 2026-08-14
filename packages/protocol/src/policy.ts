/**
 * What the agent is allowed to do: six permission groups, and every operation
 * inside them switchable on its own.
 *
 * The two compose one way only. A group that is off turns off everything under
 * it and no per-tool switch overrides that — a restriction the user set is the
 * ceiling, not a default.
 */
import { COMMANDS, TOOL_NAMES } from "./commands.js";
import type { Op } from "./commands.js";
import type { CapabilityReport, PermissionGroup, PermissionSettings } from "./capabilities.js";

/**
 * Never turned off. These are how an agent reports what is wrong and how it
 * asks instead of guessing. Disabling them does not restrict it — it makes a
 * later failure unattributable, or turns a question into an assumption.
 */
export const ESSENTIAL_OPS: readonly Op[] = ["session.status", "session.capabilities", "ask.user"];

/** How much say the user has over one operation. */
export type ToolControl =
  /** Shown in the controls, and can be turned off. */
  | "user"
  /** Shown, but locked on. */
  | "essential"
  /** Not shown: machinery rather than a tool an agent calls. */
  | "internal";

export function toolControl(op: Op): ToolControl {
  if (TOOL_NAMES[op] === null) return "internal";
  if (ESSENTIAL_OPS.includes(op)) return "essential";
  return "user";
}

/** The user-facing operations in a group, in the order they are declared. */
export function toolsInGroup(group: PermissionGroup): Op[] {
  return (Object.keys(COMMANDS) as Op[]).filter((op) => COMMANDS[op].permission === group && toolControl(op) !== "internal");
}

export interface ToolPolicy {
  permissions: PermissionSettings;
  /** Only the exceptions. Everything not listed is on, so a new tool needs no migration. */
  disabledTools: readonly Op[];
}

/** Why an operation is refused, or null when it is allowed. */
export type ToolRefusal = { reason: "group"; group: PermissionGroup } | { reason: "tool" } | null;

export function refuseTool(policy: ToolPolicy, op: Op): ToolRefusal {
  if (toolControl(op) === "essential") return null;

  const group = COMMANDS[op].permission;
  if (policy.permissions[group] === false) return { reason: "group", group };

  // Internal operations answer to their group and nothing else: `changes.apply`
  // is the Studio half of a revert, with no tool to have turned off.
  if (toolControl(op) === "internal") return null;

  if (policy.disabledTools.includes(op)) return { reason: "tool" };

  return null;
}

export function isToolAllowed(policy: ToolPolicy, op: Op): boolean {
  return refuseTool(policy, op) === null;
}

/**
 * Operations this Studio build and plugin cannot perform at all.
 *
 * Kept apart from `refuseTool` because the two answer different questions. A
 * refusal is about what the user decided and is worth telling an agent; this is
 * about what the environment cannot do, and the useful thing to do with it is
 * leave the tool out of the menu entirely.
 *
 * Transient unavailability is deliberately not included. "Studio is not
 * connected" and "nothing is running" are conditions an agent can report,
 * wait out, or ask the user to fix, and a tool that vanishes says none of that
 * — it looks exactly like a tool the user turned off.
 */
export function unavailableOps(report: CapabilityReport): Op[] {
  const dead = new Set(report.capabilities.filter((entry) => !entry.available && entry.transient !== true).map((entry) => entry.id));

  if (dead.size === 0) return [];

  return (Object.keys(COMMANDS) as Op[]).filter((op) => {
    const capability = COMMANDS[op].capability;
    return capability !== null && dead.has(capability);
  });
}

/** Counted against the group switch too, so a group that is off reads 0 of 9. */
export function groupTally(policy: ToolPolicy, group: PermissionGroup): { allowed: number; total: number } {
  const tools = toolsInGroup(group);
  return {
    allowed: tools.filter((op) => isToolAllowed(policy, op)).length,
    total: tools.length,
  };
}
