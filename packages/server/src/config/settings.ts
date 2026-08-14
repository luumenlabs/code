/**
 * Persisted settings.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PERMISSIONS, DEFAULT_PORT, isOp, toolControl } from "@luumen/code-protocol";
import type { Op, PermissionGroup, PermissionSettings, ToolPolicy } from "@luumen/code-protocol";
import { configDir, settingsFile } from "./paths.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("settings");

export interface Settings {
  port: number;
  permissions: PermissionSettings;
  /**
   * Operations turned off individually, under groups that are otherwise on.
   *
   * Only the exceptions are stored, so a release that adds a tool does not need
   * a migration and cannot arrive disabled. An unknown id is kept rather than
   * dropped: it is almost always a tool from a newer build the user has since
   * rolled back from, and silently re-enabling something they turned off is the
   * one mistake this file must not make.
   */
  disabledTools: string[];
}

const DEFAULTS: Settings = {
  port: DEFAULT_PORT,
  permissions: { ...DEFAULT_PERMISSIONS },
  disabledTools: [],
};

export class SettingsStore {
  private data: Settings;
  private readonly file: string;

  constructor(file = settingsFile()) {
    this.file = file;
    this.data = this.load();
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>;
      return {
        ...DEFAULTS,
        ...raw,
        permissions: { ...DEFAULTS.permissions, ...(raw.permissions ?? {}) },
        disabledTools: Array.isArray(raw.disabledTools) ? raw.disabledTools.filter((entry) => typeof entry === "string") : [],
      };
    } catch {
      // A missing or unreadable settings file is normal on first run.
      return { ...DEFAULTS, permissions: { ...DEFAULTS.permissions }, disabledTools: [] };
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      log.warn("Could not write settings", error);
    }
  }

  get(): Settings {
    return this.data;
  }

  get port(): number {
    const override = process.env.LUU_CODE_PORT;
    if (override) {
      const parsed = Number.parseInt(override, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
    }
    return this.data.port;
  }

  get permissions(): PermissionSettings {
    return this.data.permissions;
  }

  isAllowed(group: PermissionGroup): boolean {
    return this.data.permissions[group] !== false;
  }

  setPermission(group: PermissionGroup, allowed: boolean): void {
    this.data.permissions[group] = allowed;
    this.persist();
  }

  /**
   * The two levels of control together, in the shape the protocol's policy
   * functions take.
   *
   * Unknown ids are dropped on the way out rather than on the way in: the
   * stored list keeps them so a downgrade and upgrade does not lose the user's
   * choice, and this is where they stop being able to affect anything.
   */
  get policy(): ToolPolicy {
    return { permissions: this.data.permissions, disabledTools: this.disabledTools };
  }

  get disabledTools(): Op[] {
    return this.data.disabledTools.filter((entry): entry is Op => isOp(entry));
  }

  setToolAllowed(op: Op, allowed: boolean): void {
    if (toolControl(op) === "essential") {
      // Nothing above this stops a caller asking, and quietly recording the
      // request would show a switch that goes off and changes nothing.
      throw new Error(`${op} cannot be turned off: it is how an agent finds out what is wrong.`);
    }

    const disabled = new Set(this.data.disabledTools);

    if (allowed) {
      disabled.delete(op);
    } else {
      disabled.add(op);
    }

    this.data.disabledTools = [...disabled];
    this.persist();
  }

  setPort(port: number): void {
    this.data.port = port;
    this.persist();
  }

  get directory(): string {
    return configDir();
  }
}
