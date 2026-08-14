#!/usr/bin/env node
/**
 * The one command: build the renderer, open it full of mock data, take the shot.
 *
 *   node screenshots/shoot.mjs              # writes screenshots/out/luu-code.png
 *   node screenshots/shoot.mjs --open       # just opens the window; you photograph it
 *   node screenshots/shoot.mjs --scale=2    # 2880x1800, for a README on a retina display
 *   node screenshots/shoot.mjs --no-build   # reuse the renderer already in dist/
 *
 * `--scale` is a real device scale factor handed to Chromium, so the result is
 * rendered at that density rather than a small image blown up: text stays sharp.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const shell = process.platform === "win32";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (!has("no-build")) {
  console.log("Building the renderer…");
  const build = spawnSync("pnpm", ["exec", "vite", "build"], { cwd: root, stdio: "inherit", shell });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const env = { ...process.env };
// Set by Electron-hosted terminals. Left in place it makes Electron start as
// plain Node, which fails in a very confusing way.
delete env.ELECTRON_RUN_AS_NODE;

const scale = value("scale", "1");
const args = ["exec", "electron", "screenshots/main.cjs"];

if (scale !== "1") args.push(`--force-device-scale-factor=${scale}`);
if (!has("open")) args.push("--shot");
for (const name of ["out", "width", "height", "settle", "tab"]) {
  const given = value(name, null);
  if (given !== null) args.push(`--${name}=${given}`);
}

const electron = spawn("pnpm", args, { cwd: root, stdio: "inherit", shell, env });
electron.on("exit", (code) => process.exit(code ?? 0));
