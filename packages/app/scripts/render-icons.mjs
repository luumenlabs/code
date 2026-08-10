#!/usr/bin/env node
/**
 * Runs the icon renderer under Electron.
 *
 * A launcher rather than a direct `electron scripts/icons.cjs`, for the same
 * reason `dev.mjs` is one: Electron-hosted terminals set ELECTRON_RUN_AS_NODE,
 * and leaving it in place makes Electron start as plain Node and fail in a very
 * confusing way.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync("pnpm", ["exec", "electron", "scripts/icons.cjs"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

process.exit(result.status ?? 1);
