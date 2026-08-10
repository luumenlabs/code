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
  ];

  constructor(
    private readonly port: number,
    /** The game. Two windows on the same place share it, as the real plugin does. */
    private readonly installId = `auto-install-${(FakePlugin.nextInstall += 1)}`,
    /** The window. Generated fresh per plugin runtime, never persisted. */
    private readonly windowId = `auto-window-${(FakePlugin.nextWindow += 1)}`,
    private readonly placeId = 123,
    private readonly placeName = "Test Place",
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
      realm: this.running ? "client" : "edit",
      epoch: this.running ? 1 : 0,
      ready: this.running,
    };
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
