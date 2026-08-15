/**
 * Keeping the pieces on the same version. The app carries the Studio plugin and
 * the MCP server it was built with, and updates them together. Each channel
 * updates only from itself.
 */
import { compareVersions } from "./models.js";
import type { AgentInfo } from "./agent.js";

/**
 * Which build this is. `dev` is a checkout running from source, with its own
 * icon, window, and state on disk.
 */
export type Channel = "release" | "nightly" | "dev";

export type UpdateState =
  /** Not an installed build, so there is nothing to update. */
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  /** Downloaded and waiting for a restart. */
  | "ready"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  channel: Channel;
  currentVersion: string;
  /** The version waiting, once one is known. */
  availableVersion: string | null;
  /** Download progress, 0–100, while downloading. */
  percent: number;
  /** Why the last check failed, or why updates cannot run here. */
  message: string | null;
  checkedAt: number | null;
  /** Where to go when the app cannot install the update itself. */
  releaseUrl: string;
}

export interface PluginStatus {
  /** Roblox Studio exists on this platform. */
  supported: boolean;
  /** The Studio plugins folder, when there is one. */
  directory: string | null;
  /** Differs by channel, so a nightly plugin sits beside a release one. */
  fileName: string;
  /** The version this build of the app carries, if it carries one. */
  bundledVersion: string | null;
  /** The version the app last wrote there. */
  installedVersion: string | null;
  /** Whether that file is still on disk. */
  installed: boolean;
  /** Why the plugin cannot be installed, when it cannot. */
  message: string | null;
}

/** Everything the Settings screen needs to talk about versions. */
export interface VersionStatus {
  update: UpdateStatus;
  plugin: PluginStatus;
  /** A ready-to-paste command that runs this build's own MCP server. */
  mcpCommand: string;
}

/** True when the app should be nudging the user to update. */
export function updateWaiting(status: UpdateStatus): boolean {
  return status.state === "available" || status.state === "downloading" || status.state === "ready";
}

/**
 * Whether an installed CLI is older than what npm publishes. A null
 * `latestVersion` means the registry was unreachable, which is not up to date
 * and must not read as a problem. Not installed does not count either.
 */
export function agentBehind(agent: AgentInfo): boolean {
  if (!agent.installed || !agent.version || !agent.latestVersion) return false;
  return compareVersions(agent.version, agent.latestVersion) < 0;
}

/**
 * Whether the Studio plugin is missing, or older than the copy this build
 * carries. Dev is excluded: there `luu dev` owns the plugin file. Must stay in
 * step with `PluginInstaller.needsInstall` in the main process.
 */
export function pluginWaiting(status: PluginStatus, channel: Channel): boolean {
  if (channel === "dev") return false;
  if (!status.supported || status.bundledVersion === null) return false;
  return !status.installed || status.installedVersion !== status.bundledVersion;
}
