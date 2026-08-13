/**
 * End-to-end test of the local server with a simulated Studio plugin.
 *
 * This is the seam that matters most: pairing, the long-polled sync loop,
 * command round trips, and the failure paths an agent has to be able to
 * distinguish. A fake plugin exercises them without needing Roblox installed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "luu-code-test-"));
process.env.LUU_CODE_HOME = home;
process.env.LUU_CODE_LOG = "error";

const { createLuuCodeServer } = await import("./index.js");
const { SettingsStore } = await import("./config/settings.js");
const { detailFor } = await import("./core/activity.js");
type LuuCodeServer = Awaited<ReturnType<typeof createLuuCodeServer>>;

/**
 * Stands in for the Studio plugin: handshakes, pairs, then runs the same
 * two-loop sync the real plugin does.
 */
class FakePlugin {
  sessionId = "";
  endpointId = "";
  token = "";
  running = false;
  private stopped = false;
  private readonly handlers = new Map<string, (params: any) => unknown>();

  private static nextInstall = 0;
  private static nextWindow = 0;
  static readonly all: FakePlugin[] = [];

  readonly capabilities = [
    "inspect.datamodel",
    "inspect.scripts",
    "inspect.selection",
    "edit.instances",
    "edit.scripts",
    "output.capture",
    "runtime.inspect",
    "runtime.exec",
    "input.virtual",
    "playtest.run",
    "playtest.play",
    "playtest.multiplayer",
    "playtest.network",
    "debug.breakpoints",
    "perf.stats",
    "perf.script-profiler",
    "view.screenshot",
  ];

  /**
   * Overrides the realm this peer reports.
   *
   * Studio runs the plugin separately in each DataModel a playtest creates, so
   * a real session has an edit peer and a running one at the same time. Tests
   * that care which peer a command reached need to build that shape.
   */
  realmOverride: "edit" | "server" | "client" | null = null;
  /** False stands in for a minimized Studio window, which drops input. */
  rendering = true;

  constructor(
    private readonly port: number,
    /** The game. Two windows on the same place share it, as the real plugin does. */
    private readonly installId = `auto-install-${(FakePlugin.nextInstall += 1)}`,
    /** The window. Generated fresh per plugin runtime, never persisted. */
    private readonly windowId = `auto-window-${(FakePlugin.nextWindow += 1)}`,
    private readonly placeId = 123,
    private placeName = "Test Place",
  ) {
    FakePlugin.all.push(this);
  }

  private place(): Record<string, unknown> {
    return {
      placeId: this.placeId,
      gameId: 456,
      name: this.placeName,
      unsaved: false,
      identity: `place:${this.placeId}`,
    };
  }

  /**
   * Re-describes the open place mid-session, the way the real plugin does once
   * Roblox has answered with the published name.
   */
  redescribe(name: string, identity?: string): Promise<{ status: number; body: any }> {
    this.placeName = name;
    return this.post("/studio/sync", {
      sessionId: this.sessionId,
      endpointId: this.endpointId,
      token: this.token,
      wait: false,
      results: [],
      events: [],
      run: this.runState(),
      place: { ...this.place(), ...(identity ? { identity } : {}) },
    });
  }

  on(op: string, handler: (params: any) => unknown): this {
    this.handlers.set(op, handler);
    return this;
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  private async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  hello(token?: string): Promise<{ status: number; body: any }> {
    return this.post("/studio/hello", {
      protocolVersion: 1,
      installId: this.installId,
      windowId: this.windowId,
      pluginVersion: "0.1.0",
      studioVersion: "0.600.0",
      place: this.place(),
      capabilities: this.capabilities,
      run: this.runState(),
      token,
    });
  }

  pair(): Promise<{ status: number; body: any }> {
    return this.post("/studio/pair", {
      sessionId: this.sessionId,
      installId: this.installId,
      windowId: this.windowId,
    });
  }

  runState(): Record<string, unknown> {
    return {
      running: this.running,
      edit: !this.running,
      mode: this.running ? "play" : null,
      realm: this.realmOverride ?? (this.running ? "client" : "edit"),
      epoch: this.running ? 1 : 0,
      ready: this.running,
      playerCount: this.running ? 1 : 0,
      multiplayer: false,
      rendering: this.rendering,
    };
  }

  /** Pushes the current run state up without waiting for the parked poll. */
  async pushState(): Promise<void> {
    await this.post("/studio/sync", {
      sessionId: this.sessionId,
      endpointId: this.endpointId,
      token: this.token,
      wait: false,
      results: [],
      events: [],
      run: this.runState(),
      capabilities: this.capabilities,
    });
  }

  /** Runs the poll loop until stop() is called. */
  start(): void {
    void (async () => {
      const pending: Array<{ id: string; ok: boolean; data?: unknown; error?: unknown }> = [];

      while (!this.stopped) {
        let status: number;
        let body: any;

        try {
          ({ status, body } = await this.post<any>("/studio/sync", {
            sessionId: this.sessionId,
            endpointId: this.endpointId,
            token: this.token,
            wait: pending.length === 0,
            results: pending.splice(0, pending.length),
            events: [],
            run: this.runState(),
            capabilities: this.capabilities,
          }));
        } catch {
          // The server went away, which is exactly what the real plugin sees
          // when Luu Code closes. Stop rather than spinning.
          return;
        }

        if (status !== 200 || this.stopped) return;

        for (const command of body.commands ?? []) {
          const handler = this.handlers.get(command.op);

          if (!handler) {
            pending.push({
              id: command.id,
              ok: false,
              error: { code: "INVALID_PARAMS", message: `Fake plugin has no handler for ${command.op}` },
            });
            continue;
          }

          try {
            pending.push({ id: command.id, ok: true, data: handler(command.params) });
          } catch (error) {
            pending.push({ id: command.id, ok: false, error: { code: "INTERNAL", message: String(error) } });
          }
        }
      }
    })();
  }

  /** Pushes output without waiting for a command. */
  async pushOutput(entries: Array<Record<string, unknown>>): Promise<void> {
    await this.post("/studio/sync", {
      sessionId: this.sessionId,
      endpointId: this.endpointId,
      token: this.token,
      wait: false,
      results: [],
      events: [{ type: "output", entries }],
      run: this.runState(),
    });
  }

  stop(): void {
    this.stopped = true;
  }
}

let server: LuuCodeServer;
let plugin: FakePlugin;

async function connectPlugin(): Promise<FakePlugin> {
  const fake = new FakePlugin(server.port);

  const first = await fake.hello();
  expect(first.body.status).toBe("pairing");
  fake.sessionId = first.body.sessionId;

  expect(server.approvePairing(fake.sessionId)).toBe(true);

  const paired = await fake.pair();
  expect(paired.body.status).toBe("connected");
  fake.token = paired.body.token;
  fake.endpointId = paired.body.endpointId;

  return fake;
}

beforeAll(async () => {
  server = await createLuuCodeServer({ port: 0 });
});

afterAll(async () => {
  // Every parked poll has to be released before the listener goes away,
  // otherwise the in-flight fetches reject as unhandled noise.
  for (const fake of FakePlugin.all) fake.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  plugin?.stop();
});

describe("pairing", () => {
  it("refuses to run commands before Studio is connected", async () => {
    await expect(server.execute("dm.services", {})).rejects.toMatchObject({ code: "STUDIO_NOT_CONNECTED" });
  });

  it("requires user approval before issuing a token", async () => {
    const fake = new FakePlugin(server.port, "install-unapproved");
    const first = await fake.hello();

    expect(first.body.status).toBe("pairing");
    expect(first.body.pairingCode).toMatch(/^\d{6}$/);

    fake.sessionId = first.body.sessionId;
    const beforeApproval = await fake.pair();
    expect(beforeApproval.body.status).toBe("pending");

    server.rejectPairing(fake.sessionId);
    const afterRejection = await fake.pair();
    expect(afterRejection.body.status).toBe("rejected");
  });

  it("reconnects silently with a stored token", async () => {
    plugin = await connectPlugin();
    const again = await plugin.hello(plugin.token);

    expect(again.body.status).toBe("connected");
    expect(again.body.sessionId).toBe(plugin.sessionId);
  });

  it("does not accept an install id as a credential", async () => {
    const paired = new FakePlugin(server.port, "install-shared");
    const first = await paired.hello();
    paired.sessionId = first.body.sessionId;
    server.approvePairing(paired.sessionId);
    const approved = await paired.pair();
    expect(approved.body.status).toBe("connected");

    // Same install id, no token. Studio's settings are readable by any local
    // process, so knowing the install id must not be enough to take control.
    const impostor = new FakePlugin(server.port, "install-shared");
    const response = await impostor.hello();
    expect(response.body.status).toBe("pairing");
  });
});

/**
 * Several Studio windows open at once.
 *
 * Studio stores plugin settings once per machine, so every open window reads
 * back the same install id and the same token. The window id is the only thing
 * telling them apart, and without it both windows resolved to one session where
 * each handshake evicted the other's connection — one Studio at a time, and a
 * pairing prompt every time you switched.
 */
describe("multiple Studio windows", () => {
  /**
   * Connects one window, pairing if it has to. Passing a token is what a second
   * window on an already-approved place does: it reads the same per-place
   * credential out of Studio's settings.
   */
  async function connectWindow(
    installId: string,
    windowId: string,
    placeId: number,
    token?: string,
  ): Promise<FakePlugin> {
    const fake = new FakePlugin(server.port, installId, windowId, placeId);
    const hello = await fake.hello(token);

    if (hello.body.status === "pairing") {
      fake.sessionId = hello.body.sessionId;
      expect(server.approvePairing(fake.sessionId)).toBe(true);

      const paired = await fake.pair();
      expect(paired.body.status).toBe("connected");
      fake.token = paired.body.token;
      fake.endpointId = paired.body.endpointId;
    } else {
      expect(hello.body.status).toBe("connected");
      fake.sessionId = hello.body.sessionId;
      fake.token = hello.body.token;
      fake.endpointId = hello.body.endpointId;
    }

    // Answers with its own window id, so a routing mistake names the culprit
    // instead of just failing an equality check.
    fake.on("dm.services", () => ({
      services: [{ handle: "@h1", path: "game.Workspace", name: windowId, className: "Workspace", childCount: 0 }],
    }));
    fake.start();

    return fake;
  }

  const answered = (result: unknown): string => (result as any).services[0].name;

  it("gives each window its own session and leaves the other connected", async () => {
    const first = await connectWindow("install-pair", "window-pair-1", 4001);
    const second = await connectWindow("install-pair", "window-pair-2", 4001, first.token);

    expect(second.sessionId).not.toBe(first.sessionId);

    const sessions = server.status().sessions;
    expect(sessions.filter((entry) => entry.installId === "install-pair")).toHaveLength(2);

    // Both are still reachable. This is the regression: the second handshake
    // used to evict the first window's endpoint as a replaced connection,
    // because two windows in edit mode look like one realm colliding.
    expect(answered(await server.execute("dm.services", {}, { sessionId: first.sessionId }))).toBe("window-pair-1");
    expect(answered(await server.execute("dm.services", {}, { sessionId: second.sessionId }))).toBe("window-pair-2");

    first.stop();
    second.stop();
  });

  it("keeps a chat in its own window when another chat switches", async () => {
    const first = await connectWindow("install-stick-a", "window-stick-1", 4101);
    const second = await connectWindow("install-stick-b", "window-stick-2", 4102);

    await server.execute("session.select", { sessionId: first.sessionId }, { chat: "chat-a" });
    // Moves the default as well, which is what makes this worth asserting.
    await server.execute("session.select", { sessionId: second.sessionId }, { chat: "chat-b" });

    expect(server.status().activeSessionId).toBe(second.sessionId);
    expect(answered(await server.execute("dm.services", {}, { chat: "chat-a" }))).toBe("window-stick-1");
    expect(answered(await server.execute("dm.services", {}, { chat: "chat-b" }))).toBe("window-stick-2");

    first.stop();
    second.stop();
  });

  it("binds a chat to the window it first ran in and holds it there", async () => {
    const first = await connectWindow("install-bind-a", "window-bind-1", 4201);
    await server.execute("session.select", { sessionId: first.sessionId });

    expect(answered(await server.execute("dm.services", {}, { chat: "chat-bound" }))).toBe("window-bind-1");
    expect(server.status().chats["chat-bound"]).toBe(first.sessionId);

    // A window opening later takes the default, and the bound chat ignores it.
    const second = await connectWindow("install-bind-b", "window-bind-2", 4202);
    await server.execute("session.select", { sessionId: second.sessionId });

    expect(answered(await server.execute("dm.services", {}, { chat: "chat-bound" }))).toBe("window-bind-1");

    first.stop();
    second.stop();
  });

  it("refuses to answer a chat from a different game once its window is gone", async () => {
    const other = await connectWindow("install-alive", "window-alive", 4301);
    const owned = await connectWindow("install-closing", "window-closing", 4302);

    await server.execute("session.select", { sessionId: owned.sessionId }, { chat: "chat-orphan" });

    owned.stop();
    server.disconnectSession(owned.sessionId);

    // Another Studio is connected and would answer happily. Doing so would
    // apply this chat's work to a place it has never seen, and nothing in the
    // transcript would say it happened.
    await expect(server.execute("dm.services", {}, { chat: "chat-orphan" })).rejects.toMatchObject({
      code: "STUDIO_NOT_CONNECTED",
    });

    expect(answered(await server.execute("dm.services", {}, { sessionId: other.sessionId }))).toBe("window-alive");

    other.stop();
  });

  it("follows its place back after Studio restarts", async () => {
    const before = await connectWindow("install-restart", "window-restart-1", 4401);
    await server.execute("session.select", { sessionId: before.sessionId }, { chat: "chat-restart" });

    before.stop();
    server.disconnectSession(before.sessionId);

    // Same place, same install id, new window: Studio was reopened. The chat
    // was working here, so it belongs here, even though the session id changed.
    const after = await connectWindow("install-restart", "window-restart-2", 4401);

    expect(after.sessionId).not.toBe(before.sessionId);
    expect(answered(await server.execute("dm.services", {}, { chat: "chat-restart" }))).toBe("window-restart-2");
    expect(server.status().chats["chat-restart"]).toBe(after.sessionId);

    after.stop();
  });

  it("keeps the approval when one of two windows on a place disconnects", async () => {
    const first = await connectWindow("install-shared-credential", "window-shared-1", 4501);
    const second = await connectWindow("install-shared-credential", "window-shared-2", 4501, first.token);

    second.stop();
    server.disconnectSession(second.sessionId);

    // The approval covers the game, and the game is still open in the window
    // that was not disconnected. Revoking it would have knocked that one out too.
    const again = await first.hello(first.token);
    expect(again.body.status).toBe("connected");

    first.stop();
  });
});

describe("command round trips", () => {
  it("routes a command to Studio and returns its result", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.services", () => ({
      services: [{ handle: "@h1", path: "game.Workspace", name: "Workspace", className: "Workspace", childCount: 3 }],
    }));
    plugin.start();

    const result = (await server.execute("dm.services", {})) as any;
    expect(result.services[0].name).toBe("Workspace");
  });

  it("surfaces a Studio-side failure with its code and hint", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.get", () => {
      throw new Error("unused");
    });
    plugin.start();

    // The fake reports INTERNAL for a thrown handler; what matters is that the
    // typed failure reaches the caller rather than a generic rejection.
    await expect(server.execute("dm.get", { target: "game.Workspace.Missing" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("applies zod defaults before the command reaches Studio", async () => {
    plugin = await connectPlugin();
    let received: any = null;
    plugin.on("dm.tree", (params) => {
      received = params;
      return { root: { handle: "@h1", path: "game", name: "game", className: "DataModel", childCount: 0, children: [], truncated: false }, nodeCount: 1, truncated: false };
    });
    plugin.start();

    await server.execute("dm.tree", {});
    expect(received.maxDepth).toBe(3);
    expect(received.maxNodes).toBe(300);
  });

  it("rewrites JSON nulls so attribute removal reaches Studio", async () => {
    plugin = await connectPlugin();
    let received: any = null;
    plugin.on("dm.attributes.set", (params) => {
      received = params;
      return { instances: [], undoLabel: null, applied: ["Owner"] };
    });
    plugin.start();

    await server.execute("dm.attributes.set", { target: "game.Workspace.Part", attributes: { Owner: null } });

    // Roblox's JSON decoder drops null-valued keys, so the tag is what survives.
    expect(received.attributes.Owner).toEqual({ $t: "Nil" });
  });

  it("turns Nil tags in results back into JSON null", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.properties", () => ({
      instance: { handle: "@h1", path: "game.Workspace.Part", name: "Part", className: "Part", childCount: 0 },
      properties: { PrimaryPart: { $t: "Nil" } },
      unreadable: {},
    }));
    plugin.start();

    const result = (await server.execute("dm.properties", { target: "@h1" })) as any;
    expect(result.properties.PrimaryPart).toBeNull();
  });

  it("rejects invalid parameters before contacting Studio", async () => {
    plugin = await connectPlugin();
    plugin.start();

    await expect(server.execute("dm.get", {})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(server.execute("dm.search", {})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  /**
   * Several agents share this server, one per chat in the app, so an operation
   * has to say whose it is. Without the label the app can only guess, and it
   * guesses at whatever is on screen — which is the wrong chat exactly when two
   * of them are working at once.
   */
  it("labels activity with the conversation that asked for it", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.services", () => ({ services: [] }));
    plugin.start();

    const seen: Array<{ chat: string | null; status: string }> = [];
    const off = server.bus.subscribe((event) => {
      if (event.type === "activity") seen.push({ chat: event.activity.chat, status: event.activity.status });
    });

    await server.execute("dm.services", {}, { origin: "mcp", chat: "t_abc" });
    await server.execute("dm.services", {}, { origin: "mcp" });

    off();

    expect(seen.filter((entry) => entry.chat === "t_abc").length).toBeGreaterThan(0);
    // No chat given means no chat claimed, rather than the last one seen.
    expect(seen.some((entry) => entry.chat === null)).toBe(true);
  });
});

describe("permissions and capabilities", () => {
  it("blocks an operation whose permission group is off", async () => {
    plugin = await connectPlugin();
    plugin.start();

    server.settings.setPermission("edit", false);

    try {
      await expect(
        server.execute("dm.create", { className: "Part", parent: "game.Workspace" }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally {
      server.settings.setPermission("edit", true);
    }
  });

  it("reports why a capability is unavailable in edit mode", async () => {
    plugin = await connectPlugin();
    plugin.start();

    const report = server.capabilities();
    const input = report.capabilities.find((entry) => entry.id === "input.virtual");

    expect(input?.available).toBe(false);
    expect(input?.reason).toMatch(/running/i);
  });

  /**
   * Groups alone were not enough: "change the place" is one switch over
   * creating a part and destroying a subtree. These pin that the finer control
   * composes the only way it safely can — narrowing further, never widening.
   */
  it("refuses one tool while the rest of its group keeps working", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.create", () => ({ instances: [], undoLabel: null }));
    plugin.on("dm.delete", () => ({ instances: [], undoLabel: null, deleted: 1 }));
    plugin.start();

    server.setToolAllowed("dm.delete", false);

    try {
      await expect(server.execute("dm.delete", { targets: ["game.Workspace.Part"] })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: { tool: "studio_delete_instance" },
      });

      // The rest of the group is untouched, which is the entire point of the
      // switch existing separately from the group's.
      await expect(server.execute("dm.create", { className: "Part", parent: "game.Workspace" })).resolves.toBeTruthy();
    } finally {
      server.setToolAllowed("dm.delete", true);
    }
  });

  it("lets the group override a tool that is individually on", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.create", () => ({ instances: [], undoLabel: null }));
    plugin.start();

    server.settings.setPermission("edit", false);

    try {
      // A restriction the user set has to be the ceiling. Reported as the group
      // rather than the tool, because the group is what they would turn back on.
      await expect(server.execute("dm.create", { className: "Part", parent: "game.Workspace" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: { permission: "edit" },
      });
    } finally {
      server.settings.setPermission("edit", true);
    }
  });

  it("will not let the controls turn off the tools that explain the controls", () => {
    expect(() => server.setToolAllowed("session.status", false)).toThrow();
    expect(() => server.setToolAllowed("session.capabilities", false)).toThrow();
  });

  it("reports the disabled set so the app and an agent see the same thing", () => {
    server.setToolAllowed("script.grep", false);

    try {
      expect(server.capabilities().disabledTools).toContain("script.grep");
    } finally {
      server.setToolAllowed("script.grep", true);
    }
  });

  it("refuses input while nothing is running", async () => {
    plugin = await connectPlugin();
    plugin.start();

    await expect(server.execute("input.key", { key: "E" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
  });
});

describe("output", () => {
  it("returns only what appeared after a mark", async () => {
    plugin = await connectPlugin();
    plugin.start();

    await plugin.pushOutput([{ timestamp: Date.now(), type: "output", message: "before the change", realm: "edit" }]);
    await waitFor(async () => ((await server.execute("output.get", {})) as any).entries.length > 0);

    const { cursor } = (await server.execute("output.mark", {})) as any;

    await plugin.pushOutput([
      { timestamp: Date.now(), type: "error", message: "Shop.Handler:12: attempt to index nil", realm: "client" },
    ]);
    await waitFor(async () => ((await server.execute("output.get", { since: cursor })) as any).entries.length > 0);

    const after = (await server.execute("output.get", { since: cursor })) as any;
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].type).toBe("error");

    const errorsOnly = (await server.execute("output.get", { types: ["error"] })) as any;
    expect(errorsOnly.entries.every((entry: any) => entry.type === "error")).toBe(true);
  });
});

describe("status", () => {
  it("describes the connected session and its realms", async () => {
    plugin = await connectPlugin();
    plugin.start();

    const status = server.status();
    const session = status.sessions.find((entry) => entry.id === plugin.sessionId);

    expect(session?.place.name).toBe("Test Place");
    expect(session?.endpoints.map((endpoint) => endpoint.realm)).toContain("edit");
    expect(status.activeSessionId).toBeTruthy();
  });

  it("takes a better name for the place it is already connected to", async () => {
    plugin = await connectPlugin();

    await plugin.redescribe("Gun System");

    const session = server.status().sessions.find((entry) => entry.id === plugin.sessionId);
    expect(session?.place.name).toBe("Gun System");
  });

  it("refuses a place that claims to be a different game", async () => {
    plugin = await connectPlugin();

    // Same session, different identity. Accepting this would relabel every
    // chat bound to the window and file its changes against the wrong place.
    await plugin.redescribe("Somewhere Else", "place:999");

    const session = server.status().sessions.find((entry) => entry.id === plugin.sessionId);
    expect(session?.place.name).toBe("Test Place");
    expect(session?.place.identity).toBe("place:123");
  });
});

describe("change journal", () => {
  /** A plugin that reports a property write the way the real one does. */
  function editingPlugin(fake: FakePlugin): FakePlugin {
    return fake.on("dm.set_properties", (params) => ({
      instances: [{ handle: "@h1", path: params.target, name: "Baseplate", className: "Part", childCount: 0 }],
      undoLabel: "Set properties on Baseplate",
      applied: Object.keys(params.properties),
      rejected: {},
      changes: [
        {
          kind: "properties",
          target: { handle: "@h1", path: params.target, name: "Baseplate", className: "Part", childCount: 0 },
          parentPath: "game.Workspace",
          summary: "Set Anchored",
          revertable: true,
          properties: [{ name: "Anchored", before: false, after: true }],
        },
      ],
    }));
  }

  it("keeps the before-and-after out of the agent's result", async () => {
    plugin = editingPlugin(await connectPlugin());
    plugin.start();

    const result = (await server.execute("dm.set_properties", {
      target: "game.Workspace.Baseplate",
      properties: { Anchored: true },
    })) as any;

    expect(result.applied).toEqual(["Anchored"]);
    expect(result.changes).toBeUndefined();
  });

  it("records it against the conversation that asked, and lists it back", async () => {
    plugin = editingPlugin(await connectPlugin());
    plugin.start();

    await server.execute(
      "dm.set_properties",
      { target: "game.Workspace.Baseplate", properties: { Anchored: true } },
      { chat: "thread-a" },
    );

    const mine = (await server.execute("changes.list", { chat: "thread-a" })) as any;
    expect(mine.records).toHaveLength(1);
    expect(mine.records[0].summary).toBe("Set Anchored");
    expect(mine.records[0].op).toBe("dm.set_properties");
    expect(mine.records[0].properties[0]).toMatchObject({ name: "Anchored", before: false, after: true });

    const someoneElse = (await server.execute("changes.list", { chat: "thread-b" })) as any;
    expect(someoneElse.records).toHaveLength(0);
  });

  it("hands the record to Studio to put back, and marks it reverted", async () => {
    let applied: any = null;

    plugin = editingPlugin(await connectPlugin()).on("changes.apply", (params) => {
      applied = params;
      return { outcomes: params.records.map((record: any) => ({ id: record.id, status: "reverted" })) };
    });
    plugin.start();

    await server.execute(
      "dm.set_properties",
      { target: "game.Workspace.Baseplate", properties: { Anchored: true } },
      { chat: "thread-revert" },
    );

    const before = (await server.execute("changes.list", { chat: "thread-revert" })) as any;
    const id = before.records[0].id;

    const result = (await server.execute("changes.revert", { ids: [id] })) as any;
    expect(result.reverted).toBe(1);
    expect(applied.records[0].id).toBe(id);
    // The old value travels to Studio as the Nil-safe wire form, so a `false`
    // that was there before is still a `false` when it arrives.
    expect(applied.records[0].properties[0].before).toBe(false);

    const after = (await server.execute("changes.list", { chat: "thread-revert" })) as any;
    expect(after.records[0].revertedAt).toBeTypeOf("number");

    // Asking twice is not an error, and it does not go back to Studio again.
    applied = null;
    const again = (await server.execute("changes.revert", { ids: [id] })) as any;
    expect(again.outcomes[0]).toMatchObject({ status: "reverted", reason: "Already put back." });
    expect(applied).toBeNull();
  });

  it("reports a conflict rather than counting it as put back", async () => {
    plugin = editingPlugin(await connectPlugin()).on("changes.apply", (params) => ({
      outcomes: params.records.map((record: any) => ({
        id: record.id,
        status: "conflict",
        reason: "Anchored has been changed since.",
      })),
    }));
    plugin.start();

    await server.execute(
      "dm.set_properties",
      { target: "game.Workspace.Baseplate", properties: { Anchored: true } },
      { chat: "thread-conflict" },
    );

    const listed = (await server.execute("changes.list", { chat: "thread-conflict" })) as any;
    const result = (await server.execute("changes.revert", { ids: [listed.records[0].id] })) as any;

    expect(result.reverted).toBe(0);
    expect(result.outcomes[0].status).toBe("conflict");

    const after = (await server.execute("changes.list", { chat: "thread-conflict" })) as any;
    expect(after.records[0].revertedAt).toBeUndefined();
  });

  it("refuses ids it has never seen rather than pretending", async () => {
    plugin = await connectPlugin();
    plugin.start();

    await expect(server.execute("changes.revert", { ids: ["ch_nope_0"] })).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });
  });

  it("journals nothing for an operation that failed", async () => {
    plugin = (await connectPlugin()).on("dm.set_properties", () => {
      throw new Error("Roblox said no");
    });
    plugin.start();

    await expect(
      server.execute(
        "dm.set_properties",
        { target: "game.Workspace.Baseplate", properties: { Anchored: true } },
        { chat: "thread-failed" },
      ),
    ).rejects.toBeTruthy();

    const listed = (await server.execute("changes.list", { chat: "thread-failed" })) as any;
    expect(listed.records).toHaveLength(0);
  });
});

/**
 * Playtesting is driven entirely by StudioTestService, and the peer a request
 * reaches is part of the operation rather than a preference: only the edit peer
 * can start a session and only a running peer can end one. Nothing in this path
 * may touch the desktop.
 */
describe("playtest", () => {
  it("starts a playtest through the edit peer and waits for it to come up", async () => {
    plugin = await connectPlugin();

    let startedWith: unknown = null;
    plugin.on("run.start", (params) => {
      startedWith = params;
      // The real plugin returns before the transition lands: ExecutePlayModeAsync
      // does not come back until the playtest is over.
      setTimeout(() => {
        plugin.running = true;
        void plugin.pushState();
      }, 30);
      return plugin.runState();
    });
    plugin.start();

    const state = (await server.execute("run.start", { mode: "play", timeoutMs: 3000 })) as any;

    expect(startedWith).toMatchObject({ mode: "play" });
    expect(state.running).toBe(true);
    expect(state.ready).toBe(true);

    plugin.running = false;
    await plugin.pushState();
  });

  it("sends the stop to the running peer, not the one that started it", async () => {
    const edit = await connectPlugin();
    edit.on("run.stop", () => {
      throw new Error("stop reached the edit peer, which has no session to end");
    });
    edit.start();

    // A second connection on the same window, the way Studio's playtest
    // DataModel appears: same install and window id, a realm of its own.
    const play = new FakePlugin(server.port, (edit as any).installId, (edit as any).windowId, 123);
    play.running = true;
    play.realmOverride = "client";

    const hello = await play.hello(edit.token);
    expect(hello.body.status).toBe("connected");
    play.sessionId = hello.body.sessionId;
    play.token = hello.body.token;
    play.endpointId = hello.body.endpointId;

    let stopped = false;
    play.on("run.stop", () => {
      stopped = true;
      play.running = false;
      return play.runState();
    });
    play.start();

    await server.execute("run.stop", { timeoutMs: 3000 });

    expect(stopped).toBe(true);
    play.stop();
  });

  /**
   * The old path swallowed this. A refusal from Studio meant "fall back to
   * pressing the shortcut through the operating system", so a genuine problem
   * became a keystroke into whatever had focus and the agent was told the stop
   * had worked.
   */
  it("surfaces a refusal from Studio instead of working around it", async () => {
    plugin = await connectPlugin();
    plugin.running = true;
    plugin.start();
    await plugin.pushState();

    plugin.on("run.stop", () => {
      throw new Error("EndTest was refused");
    });

    await expect(server.execute("run.stop", { timeoutMs: 1500 })).rejects.toMatchObject({ code: "INTERNAL" });

    plugin.running = false;
  });

  it("refuses to start a playtest while one is already running", async () => {
    plugin = await connectPlugin();
    plugin.running = true;
    plugin.start();
    await plugin.pushState();

    await expect(server.execute("run.start", { mode: "play" })).rejects.toMatchObject({
      code: "PLAYTEST_ALREADY_RUNNING",
    });

    plugin.running = false;
  });
});

describe("realm-targeted exec", () => {
  it("runs the code in the realm the caller named", async () => {
    const edit = await connectPlugin();
    edit.on("runtime.exec", () => ({ value: { $t: "String", v: "edit" }, output: [], realm: "edit", elapsedMs: 1 }));
    edit.start();

    const play = new FakePlugin(server.port, (edit as any).installId, (edit as any).windowId, 123);
    play.running = true;
    play.realmOverride = "server";

    const hello = await play.hello(edit.token);
    play.sessionId = hello.body.sessionId;
    play.token = hello.body.token;
    play.endpointId = hello.body.endpointId;
    play.on("runtime.exec", () => ({ value: { $t: "String", v: "server" }, output: [], realm: "server", elapsedMs: 1 }));
    play.start();

    const onServer = (await server.execute("runtime.exec", { source: "return 1", realm: "server" })) as any;
    expect(onServer.realm).toBe("server");

    const onEdit = (await server.execute("runtime.exec", { source: "return 1", realm: "edit" })) as any;
    expect(onEdit.realm).toBe("edit");

    play.stop();
  });

  it("reports a realm that is not connected rather than answering from another", async () => {
    plugin = await connectPlugin();
    plugin.on("runtime.exec", () => ({ value: null, output: [], realm: "edit", elapsedMs: 1 }));
    plugin.start();

    await expect(server.execute("runtime.exec", { source: "return 1", realm: "client" })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_UNAVAILABLE",
    });
  });
});

describe("batched edits", () => {
  it("validates every step before any of them runs", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.batch", () => {
      throw new Error("an invalid batch should never reach Studio");
    });
    plugin.start();

    await expect(
      server.execute("dm.batch", {
        operations: [
          { op: "dm.create", params: { className: "Part", parent: "game.Workspace" } },
          { op: "dm.rename", params: { target: "game.Workspace.Part" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("refuses an operation that has no business in a batch", async () => {
    plugin = await connectPlugin();
    plugin.start();

    await expect(
      server.execute("dm.batch", { operations: [{ op: "run.start", params: { mode: "play" } }] }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  /**
   * The step that did land is a real edit, and the operation it belongs to
   * fails. Both have to be true at once: the agent must not read a half-applied
   * batch as a success, and the user must still be able to see and undo the half
   * that happened.
   */
  it("fails the operation when a step failed, but still journals what landed", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.batch", () => ({
      instances: [],
      undoLabel: "Apply 2 edit(s)",
      steps: [
        { index: 0, op: "dm.rename", status: "ok", instances: [], error: null },
        {
          index: 1,
          op: "dm.rename",
          status: "failed",
          instances: [],
          error: { code: "TARGET_NOT_FOUND", message: "game.Workspace.Missing does not exist" },
        },
      ],
      applied: 1,
      failed: 1,
      skipped: 0,
      changes: [
        {
          kind: "rename",
          target: { handle: "@b1", path: "game.Workspace.Renamed", name: "Renamed", className: "Part", childCount: 0 },
          parentPath: "game.Workspace",
          summary: "Renamed Part to Renamed",
          revertable: true,
        },
      ],
    }));
    plugin.start();

    await expect(
      server.execute(
        "dm.batch",
        {
          operations: [
            { op: "dm.rename", params: { target: "game.Workspace.Part", name: "Renamed" } },
            { op: "dm.rename", params: { target: "game.Workspace.Missing", name: "Gone" } },
          ],
        },
        { chat: "batch-thread" },
      ),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND", details: { applied: 1 } });

    const journal = (await server.execute("changes.list", { chat: "batch-thread" })) as any;
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0].summary).toBe("Renamed Part to Renamed");
  });
});

describe("script search", () => {
  it("passes the search to Studio and summarises what came back", async () => {
    plugin = await connectPlugin();
    plugin.on("script.grep", (params) => ({
      files: [
        {
          instance: { handle: "@s1", path: "game.ServerScriptService.Shop", name: "Shop", className: "Script", childCount: 0 },
          matches: [{ line: 12, column: 5, text: `  ${params.pattern}:FireServer()`, before: [], after: [] }],
          matchCount: 1,
        },
      ],
      matchCount: 1,
      scriptsSearched: 40,
      unreadable: 0,
      truncated: false,
    }));
    plugin.start();

    const result = (await server.execute("script.grep", { pattern: "BuyItem" })) as any;

    expect(result.matchCount).toBe(1);
    expect(result.files[0].matches[0].line).toBe(12);
  });
});

const SCRIPT_REF = {
  handle: "@s1",
  path: "game.ServerScriptService.Shop",
  name: "Shop",
  className: "Script",
  childCount: 0,
};

describe("script writes", () => {
  it("hands the compiler's verdict back with the write", async () => {
    plugin = await connectPlugin();
    plugin.on("script.set", () => ({
      instances: [SCRIPT_REF],
      undoLabel: "Edit Shop",
      lineCount: 12,
      syntax: { ok: false, message: "Expected 'end' (to close 'function' at line 3), got <eof>", line: 12 },
    }));
    plugin.start();

    const result = (await server.execute("script.set", { target: SCRIPT_REF.path, source: "local x = 1" })) as any;

    expect(result.syntax.ok).toBe(false);
    expect(result.syntax.line).toBe(12);
  });

  it("reads a passing check as no news", async () => {
    plugin = await connectPlugin();
    plugin.on("script.create", () => ({
      instances: [SCRIPT_REF],
      undoLabel: "Create Shop",
      lineCount: 1,
      // The plugin sends an absent value as a Nil tag like any other, so this
      // also covers the write not arriving with `message: undefined`.
      syntax: { ok: true, message: { $t: "Nil" }, line: { $t: "Nil" } },
    }));
    plugin.start();

    const result = (await server.execute("script.create", {
      className: "Script",
      parent: "game.ServerScriptService",
      name: "Shop",
      source: "print('hi')",
    })) as any;

    expect(result.syntax).toEqual({ ok: true, message: null, line: null });
  });

  it("puts the failure in the row the user reads", () => {
    const detail = detailFor("script.set", {
      lineCount: 12,
      syntax: { ok: false, message: "Expected 'end'", line: 12 },
    });

    expect(detail).toBe("12 lines — does not compile on line 12: Expected 'end'");
  });
});

describe("project rules", () => {
  it("hands back the text without the wrapper Studio stores it in", async () => {
    plugin = await connectPlugin();
    plugin.on("rules.get", () => ({
      present: true,
      path: "TestService.AGENTS",
      source: "return [==[\nCombat lives under ReplicatedStorage.\n]==]\n",
      conflict: { $t: "Nil" },
    }));
    plugin.start();

    const result = (await server.execute("rules.get", {})) as any;

    expect(result).toEqual({
      present: true,
      path: "TestService.AGENTS",
      text: "Combat lives under ReplicatedStorage.",
      conflict: null,
    });
  });

  it("wraps the text into compilable source on the way in", async () => {
    plugin = await connectPlugin();
    let written = "";
    plugin.on("rules.set", (params) => {
      written = params.source;
      return { instances: [], undoLabel: "Create the project rules", lineCount: 3, created: true };
    });
    plugin.start();

    const result = (await server.execute("rules.set", { text: "Never touch Workspace." })) as any;

    expect(written).toBe("return [==[\nNever touch Workspace.\n]==]\n");
    expect(result.created).toBe(true);
  });

  it("reads a place with no document as no rules rather than failing", async () => {
    plugin = await connectPlugin();
    plugin.on("rules.get", () => ({
      present: false,
      path: { $t: "Nil" },
      source: { $t: "Nil" },
      conflict: "Folder",
    }));
    plugin.start();

    const result = (await server.execute("rules.get", {})) as any;

    expect(result.present).toBe(false);
    expect(result.text).toBeNull();
    // Distinguishable from an empty TestService: the name is taken.
    expect(result.conflict).toBe("Folder");
  });
});

describe("replacing across scripts", () => {
  it("summarises a dry run without writing anything", async () => {
    plugin = await connectPlugin();
    plugin.on("script.replace", (params) => {
      expect(params.dryRun).toBe(true);
      return {
        instances: [],
        undoLabel: { $t: "Nil" },
        files: [
          {
            instance: SCRIPT_REF,
            replacements: 2,
            matches: [{ line: 4, before: "buyItem()", after: "purchaseItem()" }],
            matchesTruncated: false,
            syntax: { ok: true, message: { $t: "Nil" }, line: { $t: "Nil" } },
          },
        ],
        replaced: 2,
        scriptsChanged: 1,
        scriptsSearched: 40,
        unreadable: 0,
        dryRun: true,
      };
    });
    plugin.start();

    const result = (await server.execute("script.replace", {
      pattern: "buyItem",
      replacement: "purchaseItem",
      dryRun: true,
    })) as any;

    expect(result.replaced).toBe(2);
    expect(detailFor("script.replace", result)).toBe("2 replacements in 1 script — nothing written");
  });

  it("counts the scripts a sweep has just broken", () => {
    const detail = detailFor("script.replace", {
      replaced: 9,
      scriptsChanged: 3,
      dryRun: false,
      files: [{ syntax: { ok: false } }, { syntax: { ok: true } }, { syntax: null }],
    });

    expect(detail).toBe("9 replacements in 3 scripts; 1 no longer compiles");
  });
});

describe("class reflection", () => {
  it("needs something to describe", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.class_info", () => {
      throw new Error("an invalid request should never reach Studio");
    });
    plugin.start();

    await expect(server.execute("dm.class_info", {})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("names the nearest member for a guess that is not one", async () => {
    plugin = await connectPlugin();
    plugin.on("dm.class_info", (params) => ({
      className: params.className,
      creatable: true,
      isService: false,
      ancestry: ["Instance", "BasePart"],
      members: [{ name: "CanCollide", kind: "property", valueType: "boolean", value: true, writable: true, reason: { $t: "Nil" } }],
      unknown: [{ name: "Collidable", nearest: "CanCollide" }],
    }));
    plugin.start();

    const result = (await server.execute("dm.class_info", { className: "Part", members: ["Collidable"] })) as any;

    expect(result.unknown[0].nearest).toBe("CanCollide");
    expect(detailFor("dm.class_info", result)).toBe("1 member, 1 not on this class");
  });
});

describe("log breakpoints", () => {
  it("refuses a breakpoint with nothing to log", async () => {
    plugin = await connectPlugin();
    plugin.on("debug.breakpoints", () => {
      throw new Error("a breakpoint that logs nothing should never reach Studio");
    });
    plugin.start();

    await expect(
      server.execute("debug.breakpoints", { action: "set", target: SCRIPT_REF.path, line: 12 }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("reports where Studio actually put it", async () => {
    plugin = await connectPlugin();
    plugin.on("debug.breakpoints", () => ({
      breakpoints: [
        {
          instance: SCRIPT_REF,
          line: 13,
          requestedLine: 12,
          log: '"hp", humanoid.Health',
          condition: { $t: "Nil" },
          verified: true,
          realm: "edit",
        },
      ],
      removed: 0,
      realm: "edit",
    }));
    plugin.start();

    const result = (await server.execute("debug.breakpoints", {
      action: "set",
      target: SCRIPT_REF.path,
      line: 12,
      log: '"hp", humanoid.Health',
    })) as any;

    expect(result.breakpoints[0].line).toBe(13);
    expect(result.breakpoints[0].condition).toBeNull();
    expect(detailFor("debug.breakpoints", result)).toBe("1 line watched");
  });
});

describe("script profiling", () => {
  // There is no server DataModel to send this to until a playtest exists, and
  // saying that is more use than a capability that was never the problem.
  it("has no running peer to profile until a playtest is up", async () => {
    plugin = await connectPlugin();
    plugin.on("perf.script", () => {
      throw new Error("there is nothing to profile in edit mode");
    });
    plugin.start();

    await expect(server.execute("perf.script", {})).rejects.toMatchObject({ code: "RUNTIME_CONTEXT_UNAVAILABLE" });
  });

  it("leads with the function the time went into", async () => {
    const edit = await connectPlugin();
    edit.start();

    const play = new FakePlugin(server.port, (edit as any).installId, (edit as any).windowId, 123);
    play.running = true;
    play.realmOverride = "server";

    const hello = await play.hello(edit.token);
    play.sessionId = hello.body.sessionId;
    play.token = hello.body.token;
    play.endpointId = hello.body.endpointId;
    play.on("perf.script", () => ({
      realm: "server",
      durationMs: 1000,
      frequency: 1000,
      functions: [
        { name: "Shop:Refresh", source: "ServerScriptService.Shop", line: 40, totalMicroseconds: 412000, share: 0.412, engine: false },
      ],
      totalMicroseconds: 1000000,
      filtered: 6,
      truncated: false,
    }));
    play.start();

    const result = (await server.execute("perf.script", { realm: "server" })) as any;

    expect(result.functions[0].name).toBe("Shop:Refresh");
    expect(detailFor("perf.script", result)).toBe("Shop:Refresh at 41.2% of the capture");

    play.stop();
    edit.stop();
  });
});

describe("network conditions", () => {
  it("needs a number to go with a custom profile", async () => {
    plugin = await connectPlugin();
    plugin.on("run.network", () => {
      throw new Error("an empty custom profile should never reach Studio");
    });
    plugin.start();

    await expect(server.execute("run.network", { profile: "custom" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });

  it("reports what the link actually became", async () => {
    plugin = await connectPlugin();
    plugin.on("run.network", (params) => ({
      profile: params.profile,
      realm: "edit",
      before: { latencyMs: 0, jitterMs: 0, lossPercent: 0, fields: {}, unavailable: [] },
      after: {
        latencyMs: 300,
        jitterMs: 100,
        lossPercent: 0.5,
        fields: { InboundNetworkMinDelayMs: 150, OutboundNetworkMinDelayMs: 150 },
        unavailable: [],
      },
    }));
    plugin.start();

    const result = (await server.execute("run.network", { profile: "poor", realm: "edit" })) as any;

    expect(result.after.latencyMs).toBe(300);
    expect(detailFor("run.network", result)).toBe("300ms round trip, 100ms jitter, 0.5% loss");
  });
});

describe("viewport capture", () => {
  it("encodes the pixels Studio read back as a PNG", async () => {
    plugin = await connectPlugin();

    // Two pixels of solid red, which is the smallest thing that exercises the
    // stride and the row filter without asserting on compressed bytes.
    const rgba = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]);
    plugin.on("view.screenshot", () => ({
      pixels: rgba.toString("base64"),
      width: 2,
      height: 1,
      realm: "edit",
    }));
    plugin.start();

    const shot = (await server.execute("view.screenshot", {})) as any;

    expect(shot.source).toBe("viewport");
    expect(shot.realm).toBe("edit");
    expect(shot.mimeType).toBe("image/png");
    expect(shot.width).toBe(2);
    expect(Buffer.from(shot.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("will not capture a viewport from a window that is not drawing", async () => {
    plugin = await connectPlugin();
    plugin.rendering = false;
    plugin.on("view.screenshot", () => {
      throw new Error("capture was attempted against a window with no frames");
    });
    plugin.start();
    await plugin.pushState();

    await expect(server.execute("view.screenshot", {})).rejects.toMatchObject({ code: "SCREENSHOT_FAILED" });

    plugin.rendering = true;
  });
});

describe("settings", () => {
  it("persists permissions across store instances", () => {
    const store = new SettingsStore();
    store.setPermission("exec", false);

    const reloaded = new SettingsStore();
    expect(reloaded.isAllowed("exec")).toBe(false);

    reloaded.setPermission("exec", true);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for a condition");
}
