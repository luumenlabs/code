/**
 * Persisted settings and paired-session records.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PERMISSIONS, DEFAULT_PORT } from "@luumen/code-protocol";
import type { PermissionGroup, PermissionSettings } from "@luumen/code-protocol";
import { configDir, settingsFile } from "./paths.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("settings");

export interface PairedSession {
  sessionId: string;
  installId: string;
  token: string;
  placeName: string;
  placeId: number;
  pairedAt: number;
}

export interface Settings {
  port: number;
  permissions: PermissionSettings;
  /** Sessions the user has already approved, so Studio reconnects silently. */
  paired: PairedSession[];
  /** Approve new Studio sessions without asking. Off by default. */
  autoApprovePairing: boolean;
}

const DEFAULTS: Settings = {
  port: DEFAULT_PORT,
  permissions: { ...DEFAULT_PERMISSIONS },
  paired: [],
  autoApprovePairing: false,
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
        paired: Array.isArray(raw.paired) ? raw.paired : [],
      };
    } catch {
      // A missing or unreadable settings file is normal on first run.
      return { ...DEFAULTS, permissions: { ...DEFAULTS.permissions }, paired: [] };
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

  setPort(port: number): void {
    this.data.port = port;
    this.persist();
  }

  setAutoApprove(value: boolean): void {
    this.data.autoApprovePairing = value;
    this.persist();
  }

  findPairedByInstall(installId: string): PairedSession | undefined {
    return this.data.paired.find((entry) => entry.installId === installId);
  }

  findPairedByToken(token: string): PairedSession | undefined {
    return this.data.paired.find((entry) => entry.token === token);
  }

  addPaired(entry: PairedSession): void {
    this.data.paired = this.data.paired.filter((existing) => existing.installId !== entry.installId);
    this.data.paired.push(entry);
    this.persist();
  }

  removePaired(sessionId: string): void {
    const before = this.data.paired.length;
    this.data.paired = this.data.paired.filter((entry) => entry.sessionId !== sessionId);
    if (this.data.paired.length !== before) this.persist();
  }

  clearPaired(): void {
    this.data.paired = [];
    this.persist();
  }

  get directory(): string {
    return configDir();
  }
}
