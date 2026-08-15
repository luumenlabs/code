/**
 * Capability detection. What Luu Code can do varies with Studio version, OS,
 * run state, and the native layer, so the server publishes an explicit
 * capability list and gates dispatch on it.
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
  "playtest.multiplayer",
  "playtest.network",
  "output.capture",
  "runtime.inspect",
  "runtime.exec",
  "debug.breakpoints",
  "input.virtual",
  "view.screenshot",
  "view.camera",
  "perf.stats",
  "perf.script-profiler",
  "test.run",
  "assets.insert",
] as const;

export type CapabilityId = (typeof CAPABILITIES)[number];

export interface CapabilityState {
  id: CapabilityId;
  available: boolean;
  /** Why it is unavailable, phrased for the agent. */
  reason?: string;
  /**
   * True when this session could still make it available — Studio not connected
   * yet, nothing running, the window not drawing. False means this Studio build
   * or plugin cannot do it at all, and the tool is not offered to an agent.
   */
  transient?: boolean;
  /**
   * Which layer provides it. `native` is the desktop layer, and only
   * screenshots use it — every input path is a structured Studio API.
   */
  provider: "studio-plugin" | "native" | "server";
}

/** Permission groups the user can toggle. */
export const PERMISSION_GROUPS = ["inspect", "edit", "playtest", "exec", "input", "screenshot", "assets"] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export type PermissionSettings = Record<PermissionGroup, boolean>;

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  inspect: true,
  edit: true,
  playtest: true,
  exec: true,
  input: true,
  screenshot: true,
  assets: true,
};

/**
 * The plugin on the other end, and whether it is the one this build ships.
 * `missingCapabilities` is what the version string cannot give: two dev builds
 * call themselves the same thing but report different capabilities.
 */
export interface PluginState {
  version: string;
  expected: string;
  /** True when the two version strings differ outright. */
  mismatched: boolean;
  /** Capabilities this build expects a current plugin to provide and did not get. */
  missingCapabilities: CapabilityId[];
  /** True when either signal says the plugin is behind this build. */
  outdated: boolean;
}

export interface CapabilityReport {
  capabilities: CapabilityState[];
  /** Null until a Studio session is connected to have a plugin at all. */
  plugin: PluginState | null;
  permissions: PermissionSettings;
  /**
   * Operations turned off one at a time, under groups that are otherwise on.
   * Kept apart from the groups: an agent that finds a tool missing can look
   * here and see it was a choice.
   */
  disabledTools: string[];
  platform: NodeJS.Platform | string;
}

export function isCapabilityAvailable(report: CapabilityReport, id: CapabilityId): boolean {
  return report.capabilities.some((entry) => entry.id === id && entry.available);
}
