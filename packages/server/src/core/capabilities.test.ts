/**
 * Which unavailable capabilities are worth hiding a tool for — the line the MCP
 * tool list is drawn on. Hide too much and an agent with Studio closed has no
 * tool that can tell it so; hide too little and it is offered tools that fail
 * every time.
 */
import { DEFAULT_PERMISSIONS, unavailableOps } from "@luumen/code-protocol";
import type { CapabilityId } from "@luumen/code-protocol";
import { describe, expect, it } from "vitest";
import { buildCapabilityReport } from "./capabilities.js";
import type { CapabilityInputs } from "./capabilities.js";

const settings = { permissions: DEFAULT_PERMISSIONS, disabledTools: [] } as unknown as CapabilityInputs["settings"];

/** Everything a current plugin reports, so a test can take one thing away. */
const FULL: CapabilityId[] = [
  "inspect.datamodel",
  "inspect.scripts",
  "inspect.selection",
  "edit.instances",
  "edit.scripts",
  "edit.undo-history",
  "playtest.run",
  "playtest.play",
  "playtest.multiplayer",
  "playtest.network",
  "output.capture",
  "runtime.inspect",
  "runtime.exec",
  "debug.breakpoints",
  "input.virtual",
  "view.screenshot",
  "view.camera",
  "perf.stats",
  "perf.script-profiler",
  "test.run",
  "assets.insert",
];

function report(over: Partial<CapabilityInputs> = {}) {
  return buildCapabilityReport({
    studio: new Set(FULL),
    studioConnected: true,
    run: { running: true, ready: true, rendering: true } as CapabilityInputs["run"],
    desktopCaptureAvailable: true,
    settings,
    pluginVersion: "0.1.0",
    expectedPluginVersion: "0.1.0",
    ...over,
  });
}

describe("what an agent is offered", () => {
  it("hides nothing when the plugin can do everything", () => {
    expect(unavailableOps(report())).toEqual([]);
  });

  it("hides nothing at all while Studio is merely not connected", () => {
    const disconnected = report({ studio: new Set<CapabilityId>(), studioConnected: false, run: null });

    // Every reason is "Studio is not connected", which an agent can act on and
    // report. Taking the tools away would leave it unable to say even that.
    expect(unavailableOps(disconnected)).toEqual([]);
    // Desktop capture still works with Studio closed, so it is the one thing
    // here that is available rather than transiently missing.
    expect(disconnected.capabilities.filter((entry) => !entry.available).every((entry) => entry.transient)).toBe(true);
  });

  it("hides the tools of a capability the connected plugin never reports", () => {
    const stale = report({ studio: new Set(FULL.filter((id) => id !== "assets.insert")) });

    expect(unavailableOps(stale)).toEqual(["assets.insert"]);
  });

  it("keeps a tool that only needs a playtest to become usable", () => {
    const idle = report({ run: { running: false, ready: false, rendering: true } as CapabilityInputs["run"] });

    expect(unavailableOps(idle)).toEqual([]);
    expect(idle.capabilities.find((entry) => entry.id === "input.virtual")?.available).toBe(false);
  });
});

describe("noticing a plugin behind this build", () => {
  it("says nothing while the plugin matches", () => {
    expect(report().plugin).toMatchObject({ outdated: false, mismatched: false, missingCapabilities: [] });
  });

  it("catches a version older than this build", () => {
    expect(report({ pluginVersion: "0.0.9" }).plugin).toMatchObject({ mismatched: true, outdated: true });
  });

  /**
   * The case a version string cannot catch: two development builds both call
   * themselves 0.1.0, so what gives a stale plugin away is a capability this
   * build knows about that it never mentioned.
   */
  it("catches a plugin whose version matches but whose capabilities do not", () => {
    const stale = report({ studio: new Set(FULL.filter((id) => id !== "assets.insert")) });

    expect(stale.plugin).toMatchObject({ mismatched: false, outdated: true, missingCapabilities: ["assets.insert"] });
    expect(stale.capabilities.find((entry) => entry.id === "assets.insert")?.reason).toMatch(/Settings → Updates/);
  });

  it("does not blame the plugin for a capability that depends on the Studio build", () => {
    // A beta switch that is off, or a Studio release without the API. Counting
    // these would flag every install and teach the user to ignore the warning.
    const beta = report({ studio: new Set(FULL.filter((id) => id !== "debug.breakpoints")) });

    expect(beta.plugin?.outdated).toBe(false);
  });
});
