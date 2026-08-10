#!/usr/bin/env node
/**
 * Builds the Electron main process into a single CommonJS bundle.
 *
 * Two constraints force this shape:
 *
 *   1. Electron's ESM main entry cannot import the `electron` module, so the
 *      output has to be CommonJS with `electron` left external for Electron's
 *      own loader to intercept.
 *   2. The local server package is ESM-only, and the Node version Electron
 *      ships cannot require() ESM. Bundling resolves it at build time instead.
 *
 * The preload script is hand-written CommonJS and copied rather than compiled:
 * it runs before the app's module graph exists, and keeping it plain removes a
 * whole class of module-format problems.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repoRoot = resolve(root, "..", "..");

await build({
  entryPoints: [join(root, "src", "main", "main.ts")],
  outfile: join(root, "dist", "main", "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // Provided by Electron at runtime; bundling it would shadow the real module.
  external: ["electron"],

  // Bundled ESM dependencies (the Claude Agent SDK among them) call
  // `createRequire(import.meta.url)`. esbuild cannot express `import.meta` in
  // CJS output, so it emits an undefined placeholder and the app dies on load
  // with "The argument 'filename' must be a file URL object...".
  //
  // Point it at a real file URL instead. `__filename` is normally present, but
  // Electron loads this bundle through the ESM→CJS translator where it can be
  // missing, so fall back to the executable rather than crash.
  define: { "import.meta.url": "__luuImportMetaUrl" },
  banner: {
    js: [
      'const __luuImportMetaUrl = require("node:url").pathToFileURL(',
      '  typeof __filename !== "undefined" ? __filename : process.execPath',
      ").href;",
    ].join("\n"),
  },

  logLevel: "info",
});

mkdirSync(join(root, "dist", "main"), { recursive: true });
copyFileSync(join(root, "src", "main", "preload.cjs"), join(root, "dist", "main", "preload.cjs"));

// The window and taskbar icons come from the shared asset bank at the repo
// root, copied in so the packaged app carries them. Both channels ship: which
// one the app shows is decided at runtime from LUU_CODE_CHANNEL.
mkdirSync(join(root, "dist", "icons"), { recursive: true });

const icons = ["icon", "icon-nightly"].flatMap((stem) => [`${stem}.png`, `${stem}.ico`, `${stem}.icns`]);

for (const icon of icons) {
  const source = join(repoRoot, "assets", icon);
  if (existsSync(source)) copyFileSync(source, join(root, "dist", "icons", icon));
  else console.warn(`Missing ${icon} — run \`pnpm assets:icons\`.`);
}

console.log("Built the main process.");
