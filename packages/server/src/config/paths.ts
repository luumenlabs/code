/**
 * Where Luu Code keeps local state.
 *
 * Everything here stays on the machine. Nothing in this directory is uploaded
 * anywhere as a condition of using the product. Spec section 28.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  const override = process.env.LUU_CODE_HOME;
  if (override) return override;

  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Luumen", "Code");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Luumen", "Code");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "luumen", "code");
  }
}

export function settingsFile(): string {
  return join(configDir(), "settings.json");
}

/** Holds the token local clients present to the server. Written user-only. */
export function authFile(): string {
  return join(configDir(), "auth.json");
}

/** Records the port and pid of a running server so the CLI and app can find it. */
export function lockFile(): string {
  return join(configDir(), "server.json");
}

export function screenshotDir(): string {
  return join(configDir(), "screenshots");
}
