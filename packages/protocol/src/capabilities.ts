/**
 * Capability detection. Spec section 49.
 *
 * The set of things Luu Code can actually do varies with Studio version, OS,
 * whether a playtest is running, and whether the native layer is present. The
 * agent should not be encouraged to call operations that cannot work right now,
 * so the server publishes an explicit capability list and gates dispatch on it.
 */

export const CAPABILITIES = [
  "inspect.datamodel",
  "inspect.scripts",
  "inspect.selection",
  "edit.instances",
  "edit.scripts",
  "edit.undo-history",
  "playtest.run",
  "playtest.play",
  "output.capture",
  "runtime.inspect",
  "runtime.exec",
  "input.virtual",
  "input.native",
  "view.screenshot",
] as const;

export type CapabilityId = (typeof CAPABILITIES)[number];

export interface CapabilityState {
  id: CapabilityId;
  available: boolean;
  /** Why it is unavailable, phrased for the agent. */
  reason?: string;
  /** Which layer provides it, useful when diagnosing a failure. */
  provider: "studio-plugin" | "native" | "server";
}

/** Permission groups the user can toggle. Spec sections 25 and 26. */
export const PERMISSION_GROUPS = ["inspect", "edit", "playtest", "exec", "input", "screenshot"] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export type PermissionSettings = Record<PermissionGroup, boolean>;

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  inspect: true,
  edit: true,
  playtest: true,
  exec: true,
  input: true,
  screenshot: true,
};

export interface CapabilityReport {
  capabilities: CapabilityState[];
  permissions: PermissionSettings;
  platform: NodeJS.Platform | string;
}

export function isCapabilityAvailable(report: CapabilityReport, id: CapabilityId): boolean {
  return report.capabilities.some((entry) => entry.id === id && entry.available);
}
