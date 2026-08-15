/**
 * Capability reporting. A refusal names what to try instead. Availability is
 * recomputed on demand, since it changes with the run state and with which
 * Studio connection is live.
 */
import { CAPABILITIES } from "@luumen/code-protocol";
import type { CapabilityId, CapabilityReport, CapabilityState, PluginState, RunState } from "@luumen/code-protocol";
import type { SettingsStore } from "../config/settings.js";

export interface CapabilityInputs {
  /** What the connected Studio plugin says it can do. */
  studio: Set<CapabilityId>;
  studioConnected: boolean;
  run: RunState | null;
  /** True when the desktop capture path exists for this platform. */
  desktopCaptureAvailable: boolean;
  settings: SettingsStore;
  /** What the connected plugin calls itself, and what this build ships. */
  pluginVersion: string | null;
  expectedPluginVersion: string;
}

const STUDIO_PROVIDED: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "inspect.datamodel",
  "inspect.scripts",
  "inspect.selection",
  "edit.instances",
  "edit.scripts",
  "edit.undo-history",
  "playtest.play",
  "playtest.run",
  "playtest.multiplayer",
  "playtest.network",
  "output.capture",
  "runtime.inspect",
  "runtime.exec",
  "debug.breakpoints",
  "input.virtual",
  "view.camera",
  "perf.stats",
  "perf.script-profiler",
  "test.run",
  "assets.insert",
]);

export function buildCapabilityReport(inputs: CapabilityInputs): CapabilityReport {
  const capabilities: CapabilityState[] = CAPABILITIES.map((id) => describe(id, inputs));

  return {
    capabilities,
    plugin: describePlugin(inputs),
    permissions: inputs.settings.permissions,
    disabledTools: inputs.settings.disabledTools,
    platform: process.platform,
  };
}

/**
 * Whether the plugin in Studio is the one this build ships. Two signals:
 * versions catch a release app against an older release's plugin, and a missing
 * capability catches a dev build, which stamps the same version on both.
 */
function describePlugin(inputs: CapabilityInputs): PluginState | null {
  if (!inputs.studioConnected || inputs.pluginVersion === null) return null;

  const missingCapabilities = [...STUDIO_PROVIDED].filter((id) => !inputs.studio.has(id) && !OPTIONAL_IN_STUDIO.has(id));
  const mismatched = inputs.pluginVersion !== inputs.expectedPluginVersion;

  return {
    version: inputs.pluginVersion,
    expected: inputs.expectedPluginVersion,
    mismatched,
    missingCapabilities,
    outdated: mismatched || missingCapabilities.length > 0,
  };
}

/**
 * Capabilities a current plugin can legitimately fail to report, because they
 * depend on the Studio build: a beta feature that is off, an API a release does
 * not carry. Their absence says nothing about how old the plugin is.
 */
const OPTIONAL_IN_STUDIO: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "debug.breakpoints",
  "perf.script-profiler",
  "playtest.network",
  "playtest.multiplayer",
  "edit.undo-history",
  "input.virtual",
]);

function describe(id: CapabilityId, inputs: CapabilityInputs): CapabilityState {
  // Two independent capture paths, and either is enough. The in-engine one sees
  // the viewport and nothing outside it, but needs the plugin.
  if (id === "view.screenshot") {
    if (inputs.studio.has("view.screenshot")) return { id, available: true, provider: "studio-plugin" };
    if (inputs.desktopCaptureAvailable) return { id, available: true, provider: "native" };
    return {
      id,
      available: false,
      // Transient only while the in-engine path could still turn up. With
      // Studio connected, no plugin capture, and no desktop path, it cannot.
      transient: !inputs.studioConnected,
      provider: "native",
      reason: `Nothing here can capture an image: Studio is not connected and screen capture is not implemented for ${process.platform}.`,
    };
  }

  // Transient: a window opening is all it takes, and an agent told "Studio is
  // not connected" can report that.
  if (!inputs.studioConnected) {
    return { id, available: false, transient: true, provider: "studio-plugin", reason: "Roblox Studio is not connected." };
  }

  if (id === "runtime.inspect" && inputs.run && !inputs.run.running) {
    return {
      id,
      available: false,
      transient: true,
      provider: "studio-plugin",
      reason: "Nothing is running. Start a playtest to inspect runtime state.",
    };
  }

  // Unavailable while the window is not drawing: the engine discards input in
  // that state, so an agent told this restores the window rather than
  // concluding the game is broken.
  if (id === "input.virtual") {
    if (!inputs.studio.has("input.virtual")) {
      return {
        id,
        available: false,
        provider: "studio-plugin",
        reason: "This Studio build does not offer UserInputService:CreateVirtualInput(), so input cannot be delivered.",
      };
    }

    if (inputs.run && !inputs.run.running) {
      return {
        id,
        available: false,
        transient: true,
        provider: "studio-plugin",
        reason: "Input can only be delivered while the experience is running.",
      };
    }

    if (inputs.run?.rendering === false) {
      return {
        id,
        available: false,
        transient: true,
        provider: "studio-plugin",
        reason: "The Studio window is not drawing, probably because it is minimized, and the engine discards input while it is not.",
      };
    }

    return { id, available: true, provider: "studio-plugin" };
  }

  if ((id === "playtest.play" || id === "playtest.run") && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "This Studio build does not expose StudioTestService, so playtests cannot be controlled from Luu Code.",
    };
  }

  // Named as the beta it is: the fix is a switch in Studio.
  if (id === "debug.breakpoints" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason:
        "This Studio build did not accept a debugger breakpoint. The Luau debugger API is a beta feature; turn it on under File → Beta Features and reconnect.",
    };
  }

  // Whether this build can profile at all, and nothing about the run state: a
  // session reports its primary endpoint's, which during a playtest is the edit
  // peer. The peer the request reaches refuses with PLAYTEST_NOT_RUNNING.
  if (id === "perf.script-profiler" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "This Studio build does not expose ScriptProfilerService.",
    };
  }

  if (id === "playtest.network" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "This Studio build does not expose the NetworkSettings simulation fields, so the playtest link cannot be shaped.",
    };
  }

  if (id === "playtest.multiplayer" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "This Studio build does not offer StudioTestService:ExecuteMultiplayerTestAsync().",
    };
  }

  // InsertService is not a build-varying API, so a plugin that does not offer
  // this is old. Blaming the build sends an agent looking for another way in.
  if (id === "assets.insert" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason:
        outdatedReason(inputs) ??
        "The connected Studio plugin does not offer asset insertion, so store assets cannot be brought into the place.",
    };
  }

  if (STUDIO_PROVIDED.has(id)) {
    if (inputs.studio.has(id)) return { id, available: true, provider: "studio-plugin" };

    // A capability this build knows about and the plugin never mentioned is
    // almost always an old plugin, so the reason says so and names the fix. A
    // bare "did not report this capability" reads as a fact about Roblox.
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: outdatedReason(inputs) ?? "The connected Studio session did not report this capability.",
    };
  }

  return { id, available: true, provider: "server" };
}

function outdatedReason(inputs: CapabilityInputs): string | null {
  if (inputs.pluginVersion === null) return null;

  const which =
    inputs.pluginVersion === inputs.expectedPluginVersion
      ? `The Studio plugin reports version ${inputs.pluginVersion}, the same as this build, but did not offer this`
      : `The Studio plugin is version ${inputs.pluginVersion} and this build ships ${inputs.expectedPluginVersion}`;

  return `${which}. Install the plugin under Settings → Updates and restart Studio.`;
}
