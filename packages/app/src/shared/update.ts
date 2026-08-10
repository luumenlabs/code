/**
 * Keeping the pieces on the same version.
 *
 * Luu Code is three things that have to agree: the app, the Studio plugin, and
 * the MCP server a terminal talks to. When they drift, the failures are the
 * confusing kind — a capability that used to work, an operation the plugin does
 * not recognise. So the app carries the plugin and the MCP server it was built
 * with, and updates them together rather than leaving three downloads to keep
 * in step by hand.
 *
 * Each channel updates only from itself: a nightly never offers a release build
 * and a release never offers a nightly.
 */
/**
 * Which build this is.
 *
 * `dev` is a checkout running from source. It is a channel rather than a flag
 * because it needs the same separation the other two have from each other: its
 * own icon, its own window, its own state on disk. Sharing any of those with an
 * installed build is how you end up reading the wrong app's threads, or
 * debugging a window that was never the one you started.
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
