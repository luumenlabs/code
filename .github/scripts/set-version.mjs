#!/usr/bin/env node
/**
 * Stamps a version across the workspace before a build.
 *
 * The tag decides the version, so nothing in the repo has to be bumped by hand
 * and a release can never carry a stale number. `app.getVersion()` reads the
 * app package, electron-builder reads it for the installer and the update
 * feed, and the nightly channel is inferred from the prerelease suffix — so
 * these are the same fact in three places and they are written together.
 *
 *   node .github/scripts/set-version.mjs 0.2.0
 *   node .github/scripts/set-version.mjs 0.2.0-nightly.20260810.42
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a version: ${version ?? "(nothing passed)"}`);
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const targets = [
  "package.json",
  join("packages", "app", "package.json"),
  join("packages", "server", "package.json"),
  join("packages", "protocol", "package.json"),
];

// Rewritten as text rather than parsed and re-serialised: JSON.stringify
// reflows every compact array in the file, which turns a one-line version bump
// into a diff nobody asked for.
const VERSION_LINE = /^(\s{2}"version"\s*:\s*)"[^"]*"/m;

for (const target of targets) {
  const path = join(repoRoot, target);
  const source = readFileSync(path, "utf8");

  if (!VERSION_LINE.test(source)) {
    console.error(`No top-level "version" in ${target}.`);
    process.exit(1);
  }

  writeFileSync(path, source.replace(VERSION_LINE, `$1"${version}"`), "utf8");
  console.log(`${target} → ${version}`);
}
