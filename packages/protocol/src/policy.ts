/**
 * What the agent is allowed to do: permission groups, and every operation
 * inside them switchable on its own. A group that is off turns off everything
 * under it, and no per-tool switch overrides that.
 */
import { COMMANDS, TOOL_NAMES } from "./commands.js";
import type { Op } from "./commands.js";
import type { CapabilityReport, PermissionGroup, PermissionSettings } from "./capabilities.js";

/**
 * Never turned off. These are how an agent reports what is wrong and how it
 * asks instead of guessing.
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

  // Internal operations answer to their group and nothing else; `changes.apply`
  // has no tool to have been turned off.
  if (toolControl(op) === "internal") return null;

  if (policy.disabledTools.includes(op)) return { reason: "tool" };

  return null;
}

export function isToolAllowed(policy: ToolPolicy, op: Op): boolean {
  return refuseTool(policy, op) === null;
}

/**
 * Operations this Studio build and plugin cannot perform at all, and which are
 * therefore left out of the menu. `refuseTool` is the other question: what the
 * user decided, which is worth telling an agent.
 *
 * Transient unavailability is not included. "Studio is not connected" is a
 * condition an agent can report or wait out; a tool that vanishes says none of
 * that.
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
