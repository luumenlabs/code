/**
 * What the agent is allowed to do, at two levels.
 *
 * The six permission groups are the coarse control and the one most people
 * will ever touch: "may it edit the place", "may it press Play". They are what
 * the chip beside the send button shows, because that is the question worth
 * answering at a glance.
 *
 * Under each group, every operation can also be turned off on its own. Groups
 * alone were not enough: "change the place" is one switch over creating a part
 * and destroying a subtree, and someone who is happy for an agent to write
 * scripts but not delete instances had no way to say so short of turning the
 * whole group off. The two compose one way only — a group that is off turns off
 * everything inside it, and no per-tool switch can override that. A restriction
 * the user set has to be the ceiling, not a default.
 *
 * Only the exceptions are stored. An operation nobody has touched is on, which
 * means a release adding a tool does not need a migration and does not silently
 * arrive disabled.
 */
import { COMMANDS, TOOL_NAMES } from "./commands.js";
import type { Op } from "./commands.js";
import type { PermissionGroup, PermissionSettings } from "./capabilities.js";

/**
 * Operations that stay on however the controls are set.
 *
 * These are how an agent finds out what is wrong. Turning off the ability to
 * ask "is Studio connected" and "what am I allowed to do" does not restrict an
 * agent, it just stops it explaining itself — every later failure becomes
 * unattributable, including the failures caused by the restrictions themselves.
 * They read nothing about the place and change nothing in it.
 */
export const ESSENTIAL_OPS: readonly Op[] = ["session.status", "session.capabilities"];

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
  /** Operations the user has explicitly turned off. Everything else is on. */
  disabledTools: readonly Op[];
}

/** Why an operation is refused, or null when it is allowed. */
export type ToolRefusal = { reason: "group"; group: PermissionGroup } | { reason: "tool" } | null;

export function refuseTool(policy: ToolPolicy, op: Op): ToolRefusal {
  if (toolControl(op) === "essential") return null;

  const group = COMMANDS[op].permission;
  if (policy.permissions[group] === false) return { reason: "group", group };

  // Internal operations answer to their group and nothing else. `changes.apply`
  // is the Studio half of a revert the user asked for through the app; there is
  // no tool to have turned off, and refusing it would break the review panel.
  if (toolControl(op) === "internal") return null;

  if (policy.disabledTools.includes(op)) return { reason: "tool" };

  return null;
}

export function isToolAllowed(policy: ToolPolicy, op: Op): boolean {
  return refuseTool(policy, op) === null;
}

/**
 * How many of a group's tools are on, for the count beside the group switch.
 *
 * Counted against the group's own switch as well, so a group that is off reads
 * "0 of 9" rather than listing tools as enabled that cannot run.
 */
export function groupTally(policy: ToolPolicy, group: PermissionGroup): { allowed: number; total: number } {
  const tools = toolsInGroup(group);
  return {
    allowed: tools.filter((op) => isToolAllowed(policy, op)).length,
    total: tools.length,
  };
}
