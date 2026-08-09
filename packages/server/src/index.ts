/**
 * The Luu Code local server.
 *
 * Everything the product can do to Roblox Studio is assembled here and stays on
 * this machine. There is no hosted backend in the path: the harness, the CLI,
 * and any external MCP client all talk to this process. Spec sections 5.2 and 28.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import type { CapabilityReport, Op, SessionStatus, StudioRealm } from "@luumen/code-protocol";
import { SettingsStore } from "./config/settings.js";
import { generateToken, writeClientAuth } from "./core/auth.js";
import { Dispatcher } from "./core/dispatcher.js";
import { EventBus } from "./core/events.js";
import { OutputStore } from "./core/output.js";
import { RunControl } from "./core/runControl.js";
import { SessionRegistry } from "./core/sessions.js";
import { startHttpServer } from "./http/server.js";
import type { RunningHttpServer } from "./http/server.js";
import { createNativeInput } from "./native/input.js";
import { platformScreenshotProvider } from "./native/screenshot.js";
import type { ScreenshotProvider } from "./native/screenshot.js";
import { createLogger } from "./util/logger.js";

export const SERVER_VERSION = "0.1.0";

const log = createLogger("server");

export interface LuuCodeServerOptions {
  port?: number;
  settings?: SettingsStore;
  /**
   * Overrides the platform screenshot path. The Electron harness passes a
   * compositor-based provider here, which can capture Studio even when it is
   * not the frontmost window. Spec section 22.
   */
  screenshotProvider?: ScreenshotProvider;
}

export interface LuuCodeServer {
  readonly port: number;
  readonly token: string;
  readonly bus: EventBus;
  readonly settings: SettingsStore;
  execute(op: Op | string, params?: unknown, context?: { origin?: "harness" | "mcp" | "internal"; sessionId?: string; realm?: StudioRealm }): Promise<unknown>;
  status(): SessionStatus;
  capabilities(): CapabilityReport;
  approvePairing(sessionId: string): boolean;
  rejectPairing(sessionId: string): boolean;
  /** Drops a Studio session and forgets its pairing. */
  disconnectSession(sessionId: string): void;
  setScreenshotProvider(provider: ScreenshotProvider | null): void;
  close(): Promise<void>;
}

export async function createLuuCodeServer(options: LuuCodeServerOptions = {}): Promise<LuuCodeServer> {
  const settings = options.settings ?? new SettingsStore();
  const bus = new EventBus();
  const output = new OutputStore();
  const nativeInput = createNativeInput();

  let screenshotProvider: ScreenshotProvider | null = options.screenshotProvider ?? platformScreenshotProvider();

  const sessions = new SessionRegistry(
    settings,
    bus,
    {
      onOutput: (sessionId, entries) => {
        const added = output.for(sessionId).append(entries);
        if (added.length > 0) {
          bus.emit({ type: "output", sessionId, entries: added });
        }
      },
      onRunState: (sessionId, state) => {
        log.info(`${sessionId}: ${state.running ? `running (${state.realm})` : "edit mode"}`);
      },
    },
    SERVER_VERSION,
  );

  const runControl = new RunControl(sessions, nativeInput);

  const dispatcher = new Dispatcher({
    sessions,
    settings,
    bus,
    output,
    runControl,
    nativeInput,
    getScreenshotProvider: () => screenshotProvider,
  });

  sessions.start();

  const clientToken = generateToken();
  const requestedPort = options.port ?? settings.port;

  let http: RunningHttpServer;

  try {
    http = await startHttpServer(
      { sessions, dispatcher, settings, bus, clientToken, version: SERVER_VERSION },
      requestedPort,
    );
  } catch (error) {
    sessions.stop();

    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new LuuCodeError("INTERNAL", `Port ${requestedPort} is already in use.`, {
        hint: "Another Luu Code server is probably running. Stop it, or set LUU_CODE_PORT to a free port.",
        cause: error,
      });
    }

    throw error;
  }

  // Published after the listener is up so anything that reads the file can
  // connect immediately.
  writeClientAuth(clientToken, http.port);

  log.info(`Luu Code server listening on 127.0.0.1:${http.port}`);

  return {
    port: http.port,
    token: clientToken,
    bus,
    settings,
    execute: (op, params, context) =>
      dispatcher.execute(op, params, {
        origin: context?.origin ?? "internal",
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.realm ? { realm: context.realm } : {}),
      }),
    status: () => sessions.status(),
    capabilities: () => dispatcher.capabilityReport(),
    approvePairing: (sessionId) => sessions.approvePairing(sessionId),
    rejectPairing: (sessionId) => sessions.rejectPairing(sessionId),
    disconnectSession: (sessionId) => {
      sessions.disconnect(sessionId);
      output.drop(sessionId);
    },
    setScreenshotProvider: (provider) => {
      screenshotProvider = provider ?? platformScreenshotProvider();
    },
    close: async () => {
      sessions.stop();
      await http.close();
    },
  };
}

export { SettingsStore } from "./config/settings.js";
export { readClientAuth } from "./core/auth.js";
export { MCP_TOOLS } from "./mcp/tools.js";
export { createMcpServer } from "./mcp/server.js";
export type { ScreenshotProvider, ScreenshotRequest } from "./native/screenshot.js";
