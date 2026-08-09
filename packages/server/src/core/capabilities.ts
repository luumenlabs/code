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
  nativeInputAvailable: boolean;
  screenshotAvailable: boolean;
  settings: SettingsStore;
}

const STUDIO_PROVIDED: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "inspect.datamodel",
  "inspect.scripts",
  "inspect.selection",
  "edit.instances",
  "edit.scripts",
  "edit.undo-history",
  "playtest.run",
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
  if (id === "view.screenshot") {
    return inputs.screenshotAvailable
      ? { id, available: true, provider: "native" }
      : {
          id,
          available: false,
          provider: "native",
          reason: `Screen capture is not implemented for ${process.platform}.`,
        };
  }

  if (id === "input.native") {
    return inputs.nativeInputAvailable
      ? { id, available: true, provider: "native" }
      : {
          id,
          available: false,
          provider: "native",
          reason: `Desktop input is not implemented for ${process.platform}.`,
        };
  }

  if (!inputs.studioConnected) {
    return { id, available: false, provider: "studio-plugin", reason: "Roblox Studio is not connected." };
  }

  if (id === "playtest.play") {
    // Play has two independent paths, and only one of them has to work.
    if (inputs.studio.has("playtest.play")) return { id, available: true, provider: "studio-plugin" };
    if (inputs.nativeInputAvailable) return { id, available: true, provider: "native" };
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: 'Studio cannot start Play mode here. Use mode "run" for a server-only playtest.',
    };
  }

  if (id === "runtime.inspect" && inputs.run && !inputs.run.running) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "Nothing is running. Start a playtest to inspect runtime state.",
    };
  }

  if (id === "input.virtual" && inputs.run && !inputs.run.running) {
    return {
      id,
      available: false,
      provider: "studio-plugin",
      reason: "Input can only be delivered while the experience is running.",
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
