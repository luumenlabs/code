/**
 * Installing the Studio plugin, so the two halves stay on the same version. The
 * app carries the plugin it was built with and writes it where Studio reads
 * plugins from. Nothing is written until the install button is pressed or the
 * switch in Settings is on. Each channel installs under its own file name.
 */
import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Channel, PluginStatus } from "../shared/update.js";

/** What CI stages into the packaged app's resources. */
const BUNDLED_NAME = "LuuCode.rbxm";

const INSTALLED_NAME: Record<Channel, string> = {
  release: "LuuCode.rbxm",
  nightly: "LuuCodeNightly.rbxm",
  // A dev build must not overwrite the plugin the installed app put there.
  dev: "LuuCodeDev.rbxm",
};

interface InstallRecord {
  version: string;
  fileName: string;
  installedAt: number;
}

/**
 * Where Roblox Studio looks for plugins. Studio reads this folder on start and
 * nowhere else. Only the platform decides whether there is an answer — null
 * here means Studio does not run at all, never a missing variable.
 */
export function studioPluginsDir(): string | null {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Roblox", "Plugins");
  }

  if (process.platform === "darwin") {
    // Through Electron, so a Documents folder relocated by iCloud still resolves.
    return join(documentsDir(), "Roblox", "Plugins");
  }

  return null;
}

function documentsDir(): string {
  try {
    return app.getPath("documents");
  } catch {
    return join(homedir(), "Documents");
  }
}

export class PluginInstaller {
  private readonly recordPath: string;

  constructor(
    private readonly channel: Channel,
    stateDir: string,
    private readonly appRoot: string,
  ) {
    this.recordPath = join(stateDir, "plugin.json");
  }

  /**
   * The plugin file this build carries. Packaged, it sits in resources beside
   * the app; in a checkout it is whatever `luu run bundle` last produced.
   */
  private bundledPath(): string | null {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, "plugin", BUNDLED_NAME)]
      : [
          join(this.appRoot, "build", "plugin", BUNDLED_NAME),
          join(this.appRoot, "..", "..", "plugin", BUNDLED_NAME),
        ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  private record(): InstallRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.recordPath, "utf8")) as Partial<InstallRecord>;
      if (typeof parsed.version !== "string" || typeof parsed.fileName !== "string") return null;
      return { version: parsed.version, fileName: parsed.fileName, installedAt: parsed.installedAt ?? 0 };
    } catch {
      return null;
    }
  }

  status(): PluginStatus {
    const directory = studioPluginsDir();
    const fileName = INSTALLED_NAME[this.channel];
    const bundled = this.bundledPath();
    const record = this.record();

    const installed = directory !== null && existsSync(join(directory, fileName));

    return {
      supported: directory !== null,
      directory,
      fileName,
      bundledVersion: bundled ? app.getVersion() : null,
      // A file the user deleted is not installed, whatever the record says.
      installedVersion: installed ? (record?.version ?? null) : null,
      installed,
      message: this.problem(directory, bundled),
    };
  }

  private problem(directory: string | null, bundled: string | null): string | null {
    if (directory === null) {
      return "Roblox Studio does not run on this platform.";
    }

    if (bundled === null) {
      // A fresh checkout has no plugin until someone builds one.
      return app.isPackaged
        ? "This build did not ship a plugin. Download LuuCode.rbxm from the release instead."
        : "No plugin in this build. Run `luu run bundle` in plugin/ and restart the app, or `luu build` to install it into Studio directly.";
    }

    return null;
  }

  /**
   * True when the app should install on its own. Never on the dev channel,
   * where `luu dev` owns the plugin file and a startup install would undo a
   * running watch. The Install button still works.
   */
  needsInstall(): boolean {
    if (this.channel === "dev") return false;

    const status = this.status();
    if (!status.supported || status.bundledVersion === null) return false;
    return !status.installed || status.installedVersion !== status.bundledVersion;
  }

  /**
   * Writes the plugin into the Studio plugins folder. Success means the file is
   * in place; Studio picks it up on its next start.
   */
  install(): PluginStatus {
    const directory = studioPluginsDir();
    const bundled = this.bundledPath();

    if (directory === null || bundled === null) return this.status();

    const fileName = INSTALLED_NAME[this.channel];
    const target = join(directory, fileName);

    try {
      mkdirSync(directory, { recursive: true });
      copyFileSync(bundled, target);

      const record: InstallRecord = { version: app.getVersion(), fileName, installedAt: Date.now() };
      writeFileSync(this.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (error) {
      return {
        ...this.status(),
        message: `Could not write to the plugins folder: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return this.status();
  }

  /** Removes only the file this app wrote, and only for this channel. */
  uninstall(): PluginStatus {
    const directory = studioPluginsDir();
    if (directory === null) return this.status();

    try {
      rmSync(join(directory, INSTALLED_NAME[this.channel]), { force: true });
      rmSync(this.recordPath, { force: true });
    } catch {
      // Already gone, or Studio has it open; the status reports what is true.
    }

    return this.status();
  }
}
