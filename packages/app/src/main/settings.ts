/**
 * Settings on disk.
 *
 * One JSON file, written atomically, read once at startup. Small enough that
 * debouncing would be more machinery than it saves.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, withDefaults } from "../shared/settings.js";
import type { AppSettings } from "../shared/settings.js";

export class SettingsStore {
  private settings: AppSettings;
  private readonly path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "settings.json");
    this.settings = this.load();
  }

  current(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = withDefaults({ ...this.settings, ...patch });
    this.save();
    return this.settings;
  }

  /**
   * Preferences go back to their defaults; the rules do not. They are something
   * the user wrote rather than a knob they turned, and the button that restores
   * them sits on a different panel entirely.
   */
  reset(): AppSettings {
    this.settings = { ...DEFAULT_SETTINGS, globalRules: this.settings.globalRules };
    this.save();
    return this.settings;
  }

  private load(): AppSettings {
    if (!existsSync(this.path)) return DEFAULT_SETTINGS;

    try {
      return withDefaults(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // A settings file that will not parse is not worth failing to start over.
      return DEFAULT_SETTINGS;
    }
  }

  private save(): void {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    renameSync(temp, this.path);
  }
}
