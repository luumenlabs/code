#!/usr/bin/env node
/**
 * Development launcher: esbuild for the main process, Vite for the renderer,
 * then Electron pointed at the dev server.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const shell = process.platform === "win32";

const build = spawnSync("node", ["scripts/build-main.mjs"], { cwd: root, stdio: "inherit", shell });
if (build.status !== 0) process.exit(build.status ?? 1);

const vite = spawn("pnpm", ["exec", "vite", "--port", "5273", "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
  shell,
});

let started = false;

vite.stdout.setEncoding("utf8");
vite.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);

  if (started || !chunk.includes("ready in")) return;
  started = true;

  const env = { ...process.env, LUU_CODE_DEV_SERVER: "http://localhost:5273" };

  // Set by Electron-hosted terminals. Left in place it makes Electron start as
  // plain Node, which fails in a very confusing way.
  delete env.ELECTRON_RUN_AS_NODE;

  const electron = spawn("pnpm", ["exec", "electron", "."], { cwd: root, stdio: "inherit", shell, env });

  electron.on("exit", (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
});

process.on("SIGINT", () => {
  vite.kill();
  process.exit(0);
});
