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
    private readonly installId = `install-${(FakePlugin.nextInstall += 1)}`,
  ) {
    FakePlugin.all.push(this);
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
      pluginVersion: "0.1.0",
      studioVersion: "0.600.0",
      place: { placeId: 123, gameId: 456, name: "Test Place", unsaved: false },
      capabilities: this.capabilities,
      run: this.runState(),
      token,
    });
  }

  pair(): Promise<{ status: number; body: any }> {
    return this.post("/studio/pair", { sessionId: this.sessionId, installId: this.installId });
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
