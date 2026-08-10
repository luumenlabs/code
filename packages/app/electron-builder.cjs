/**
 * Packaging, for both channels.
 *
 * One config, switched by LUU_CODE_CHANNEL, because a nightly build is the same
 * app with a different identity — its own application id, name, icon, and
 * update feed. That separation is what lets a nightly install sit beside a
 * release install instead of overwriting it, and what keeps a nightly from ever
 * offering a release build as its update (and the reverse).
 *
 * Two things ride along outside the asar, as plain files on disk:
 *
 *   - the Studio plugin, so the app can install a plugin that matches the build
 *     the user is running rather than whatever they last downloaded by hand;
 *   - the MCP entry point, so `luu-code-mcp` exists without npm and cannot
 *     drift from the app.
 *
 * Signing is deliberately absent. Unsigned builds warn on first run, and macOS
 * cannot auto-update unsigned, which the updater reports rather than hides. The
 * hooks are here as comments; they switch on the day certificates exist.
 */
const nightly = process.env.LUU_CODE_CHANNEL === "nightly";

const productName = nightly ? "Luu Code Nightly" : "Luu Code";
const icon = nightly ? "dist/icons/icon-nightly" : "dist/icons/icon";

/**
 * What downloads are called.
 *
 * Spelled out rather than built from `${name}`, which expands to the scoped
 * package name — the slash in `@luumen/code-app` is read as a directory and the
 * installer fails to write. `${version}` and the rest are electron-builder's
 * own macros, so they are escaped through to it untouched.
 */
const slug = nightly ? "LuuCodeNightly" : "LuuCode";
const artifact = (suffix) => `${slug}-\${version}-\${arch}${suffix}`;

module.exports = {
  appId: nightly ? "dev.luumen.code.nightly" : "dev.luumen.code",
  productName,
  copyright: `Copyright © ${new Date().getFullYear()} luumenlabs`,

  directories: {
    output: nightly ? "release/nightly" : "release/stable",
    // Kept off the default `build/`, which is where CI stages the plugin.
    buildResources: "build/resources",
  },

  // The main process and the renderer are both bundled before packaging, so
  // `dist` is the app. Production dependencies still come along: the Claude
  // Agent SDK resolves files inside its own package at runtime, and a bundler
  // cannot see through that.
  files: ["dist/**/*", "package.json", "!dist/**/*.map", "!dist/mcp/**"],

  extraResources: [
    // Copied in by CI from the plugin job. Missing locally, which is fine —
    // the app reports the plugin as unavailable rather than failing to start.
    { from: "build/plugin", to: "plugin", filter: ["**/*.rbxm"] },
    { from: "dist/mcp", to: "mcp", filter: ["**/*"] },
  ],

  asar: true,
  npmRebuild: false,

  publish: [
    {
      provider: "github",
      owner: "luumenlabs",
      repo: "code",
      // Nightly writes latest-nightly.yml and reads it back, so the two
      // channels never see each other's builds.
      ...(nightly ? { channel: "nightly" } : {}),
      releaseType: "draft",
    },
  ],

  win: {
    icon: `${icon}.ico`,
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    // signAndEditExecutable / certificateFile go here once there is a cert.
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: productName,
    uninstallDisplayName: productName,
    artifactName: artifact("-setup.${ext}"),
  },

  mac: {
    icon: `${icon}.icns`,
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["x64", "arm64"] },
      // The updater needs the zip; the dmg is what people download.
      { target: "zip", arch: ["x64", "arm64"] },
    ],
    // Unsigned for now. `identity: null` stops electron-builder looking for a
    // certificate and failing the build on a machine that has one for
    // something else. Remove it, and add notarize: true, when signing starts.
    identity: null,
    artifactName: artifact("-mac.${ext}"),
  },

  dmg: {
    artifactName: artifact(".${ext}"),
  },

  linux: {
    icon: `${icon}.png`,
    category: "Development",
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    artifactName: artifact(".${ext}"),
    synopsis: "Use Claude Code or Codex with Roblox Studio.",
  },
};
