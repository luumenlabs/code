/**
 * App updates, one channel at a time. electron-updater does the work; this
 * decides when it runs and turns its events into one status the UI renders.
 *
 *   - A build only updates from its own channel. The feed is baked in at
 *     package time (`latest.yml` or `latest-nightly.yml`).
 *   - The check is automatic; the download is a button.
 *
 * Unsigned builds cannot self-install on macOS. That is reported as an error
 * with the release page as the way through.
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { Channel, UpdateStatus } from "../shared/update.js";

const RELEASES_URL = "https://github.com/luumenlabs/code/releases";

/** Long enough that it never competes with the window opening. */
const FIRST_CHECK_DELAY_MS = 10_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class Updater {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(channel: Channel, private readonly onChange: (status: UpdateStatus) => void) {
    this.status = {
      state: app.isPackaged ? "idle" : "unsupported",
      channel,
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: 0,
      message: app.isPackaged ? null : "Updates only run in an installed build.",
      checkedAt: null,
      releaseUrl: RELEASES_URL,
    };

    if (!app.isPackaged) return;

    autoUpdater.autoDownload = false;
    // Applied on quit if the user never restarts deliberately.
    autoUpdater.autoInstallOnAppQuit = true;
    // A nightly is published as a GitHub prerelease; without this the provider
    // only ever looks at the newest full release.
    autoUpdater.allowPrerelease = channel === "nightly";
    autoUpdater.logger = null;

    autoUpdater.on("checking-for-update", () => this.set({ state: "checking", message: null }));

    autoUpdater.on("update-available", (info) =>
      this.set({ state: "available", availableVersion: info.version, checkedAt: Date.now(), message: null }),
    );

    autoUpdater.on("update-not-available", () =>
      this.set({ state: "idle", availableVersion: null, checkedAt: Date.now(), message: null }),
    );

    autoUpdater.on("download-progress", (progress) =>
      this.set({ state: "downloading", percent: Math.round(progress.percent) }),
    );

    autoUpdater.on("update-downloaded", (info) =>
      this.set({ state: "ready", availableVersion: info.version, percent: 100, message: null }),
    );

    autoUpdater.on("error", (error) => this.set({ state: "error", message: describe(error) }));
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** Starts the background schedule. Checks only; never downloads. */
  start(): void {
    if (!app.isPackaged) return;

    const timer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    timer.unref?.();

    this.timer = setInterval(() => void this.check(), RECHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status;
    // A check while something is already downloaded would report "idle" over a
    // finished download and lose the restart prompt.
    if (this.status.state === "downloading" || this.status.state === "ready") return this.status;

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ state: "error", message: describe(error), checkedAt: Date.now() });
    }

    return this.status;
  }

  async download(): Promise<UpdateStatus> {
    if (this.status.state !== "available" && this.status.state !== "error") return this.status;

    this.set({ state: "downloading", percent: 0, message: null });

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.set({ state: "error", message: describe(error) });
    }

    return this.status;
  }

  /** Quits and installs. Returns only if it could not. */
  install(): UpdateStatus {
    if (this.status.state !== "ready") return this.status;

    try {
      // Not silent: an app that vanishes and comes back reads as a crash.
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    } catch (error) {
      this.set({ state: "error", message: describe(error) });
    }

    return this.status;
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }
}

/** electron-updater's errors are written for a log, not for a person. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/code signature|not signed|rejected by macOS/i.test(message)) {
    return "This build is not signed, so macOS will not let it replace itself. Download the new version from the releases page.";
  }

  if (/ENOTFOUND|ENETUNREACH|EAI_AGAIN|getaddrinfo|network|timeout/i.test(message)) {
    return "Could not reach GitHub to check for updates.";
  }

  if (/404|no published versions|cannot find/i.test(message)) {
    return "No published build was found for this channel yet.";
  }

  return message;
}
