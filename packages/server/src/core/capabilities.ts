/**
 * Capability reporting. Spec section 49.
 *
 * The agent should not be encouraged to call something that cannot work in the
 * current environment, and when it does try, the reason should say what to do
 * instead. Availability is recomputed on demand because it changes with the run
 * state and with which Studio connection is live.
 */
import { CAPABILITIES } from "@luumen/code-protocol";
import type { CapabilityId, CapabilityReport, CapabilityState, RunState } from "@luumen/code-protocol";
import type { SettingsStore } from "../config/settings.js";

export interface CapabilityInputs {
  /** What the connected Studio plugin says it can do. */
  studio: Set<CapabilityId>;
  studioConnected: boolean;
  run: RunState | null;
  /** True when the desktop capture path exists for this platform. */
  desktopCaptureAvailable: boolean;
  settings: SettingsStore;
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
  "output.capture",
  "runtime.inspect",
  "runtime.exec",
  "input.virtual",
]);

export function buildCapabilityReport(inputs: CapabilityInputs): CapabilityReport {
  const capabilities: CapabilityState[] = CAPABILITIES.map((id) => describe(id, inputs));

  return {
    capabilities,
    permissions: inputs.settings.permissions,
    platform: process.platform,
  };
}

function describe(id: CapabilityId, inputs: CapabilityInputs): CapabilityState {
  // Two independent capture paths, and either is enough. The in-engine one is
  // better — it sees the viewport during a playtest and nothing outside it — but
  // it needs the plugin, so a desktop capture still answers with Studio closed.
  if (id === "view.screenshot") {
    if (inputs.studio.has("view.screenshot")) return { id, available: true, provider: "studio-plugin" };
    if (inputs.desktopCaptureAvailable) return { id, available: true, provider: "native" };
    return {
      id,
      available: false,
      provider: "native",
      reason: `Nothing here can capture an image: Studio is not connected and screen capture is not implemented for ${process.platform}.`,
    };
  }

  if (!inputs.studioConnected) {
    return { id, available: false, provider: "studio-plugin", reason: "Roblox Studio is not connected." };
  }

  if (id === "runtime.inspect" && inputs.run && !inputs.run.running) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "Nothing is running. Start a playtest to inspect runtime state.",
    };
  }

  // Reported unavailable while the window is not drawing, because the engine
  // discards input in that state. Saying so up front is the difference between
  // an agent restoring the window and one concluding the game is broken.
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
        provider: "studio-plugin",
        reason: "Input can only be delivered while the experience is running.",
      };
    }

    if (inputs.run?.rendering === false) {
      return {
        id,
        available: false,
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

  if (id === "playtest.multiplayer" && !inputs.studio.has(id)) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "This Studio build does not offer StudioTestService:ExecuteMultiplayerTestAsync().",
    };
  }

  if (STUDIO_PROVIDED.has(id)) {
    return inputs.studio.has(id)
      ? { id, available: true, provider: "studio-plugin" }
      : {
          id,
          available: false,
          provider: "studio-plugin",
          reason: "The connected Studio session did not report this capability.",
        };
  }

  return { id, available: true, provider: "server" };
}
