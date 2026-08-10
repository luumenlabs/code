/**
 * Luu Code — Electron main process.
 *
 * Starts the local server in-process, registers the compositor-based screenshot
 * provider, owns the coding-agent session and the conversation history, and
 * serves the window. Closing the app closes the server it started; an external
 * MCP client can keep working by starting its own with `luu-code serve`.
 * Spec sections 5.1 and 21.
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLuuCodeServer } from "@luumen/code-server";
import type { LuuCodeServer } from "@luumen/code-server";
import type { PermissionGroup, ServerEvent } from "@luumen/code-protocol";
import { AgentManager } from "./agents/manager.js";
import { generateTitle, titleProvider } from "./agents/title.js";
import { createElectronScreenshotProvider } from "./screenshot.js";
import { SettingsStore } from "./settings.js";
import { ThreadStore } from "./threads.js";
import { fromAgentEvent, fromServerEvent, userEntry } from "./transcript.js";
import type { AgentEvent, Attachment, TranscriptEntry } from "../shared/agent.js";
import type { HarnessSnapshot } from "../shared/bridge.js";
import { createSelection, defaultModel, findModel } from "../shared/models.js";
import type { ModelSelection } from "../shared/models.js";
import type { AppSettings } from "../shared/settings.js";

/**
 * The place the agent is currently pointed at.
 *
 * A conversation belongs to a Roblox place, so there is nowhere to file one
 * while Studio is disconnected. Rather than inventing an "unknown" bucket, the
 * app refuses to start a chat until a place is connected.
 */
function connectedPlace(): { placeId: number; name: string } | null {
  const status = server?.status();
  const session = status?.sessions.find((entry) => entry.active) ?? status?.sessions[0];
  if (!session) return null;
  return { placeId: session.place.placeId, name: session.place.name };
}

function requirePlace(): { placeId: number; name: string } {
  const place = connectedPlace();

  if (!place) {
    throw new Error(
      "Connect Roblox Studio first. Conversations are filed against the place they are about, so there is nowhere to put this one yet.",
    );
  }

  return place;
}

// Resolved from the app root rather than the module path: the main process is
// bundled, so a module-relative path would depend on the bundle layout.
const appRoot = (): string => app.getAppPath();
const isDev = !app.isPackaged;

let window: BrowserWindow | null = null;
let server: LuuCodeServer | null = null;
let agents: AgentManager | null = null;
let threads: ThreadStore | null = null;
let settings: SettingsStore | null = null;

/**
 * The model the next message will use.
 *
 * A draft has no thread to store a selection on, but the composer still shows
 * one and the user can still change it, so it lives here until a message turns
 * the draft into a thread.
 */
let draftSelection: ModelSelection | null = null;

/** The open thread's model, or the draft's. */
function activeSelection(): ModelSelection | null {
  return threads?.active()?.modelSelection ?? draftSelection;
}

function broadcast(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload);
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    // Wide enough that the thread list, the conversation, and the Studio dock
    // can all be open without the conversation being squeezed.
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#171717",
    title: "Luu Code",
    autoHideMenuBar: true,
    // The window chrome is part of the app: the title bar carries the Studio
    // connection state, which the user needs visible at all times.
    // No titleBarOverlay: Windows only lets it take two colours, so it never
    // matches the rest of the chrome. The app draws its own controls instead.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: join(appRoot(), "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // External links belong in the user's browser, not in a window that can talk
  // to Roblox Studio.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServer = process.env.LUU_CODE_DEV_SERVER;

  if (isDev && devServer) {
    await window.loadURL(devServer);
  } else {
    await window.loadFile(join(appRoot(), "dist", "renderer", "index.html"));
  }

  // The controls need to know which glyph to show.
  window.on("maximize", () => broadcast("window-state", true));
  window.on("unmaximize", () => broadcast("window-state", false));

  window.on("closed", () => {
    window = null;
  });
}

function requireServer(): LuuCodeServer {
  if (!server) throw new Error("The local server is not running.");
  return server;
}

function requireAgents(): AgentManager {
  if (!agents) throw new Error("The agent manager is not ready.");
  return agents;
}

function requireThreads(): ThreadStore {
  if (!threads) throw new Error("Thread storage is not ready.");
  return threads;
}

function requireSettings(): SettingsStore {
  if (!settings) throw new Error("Settings are not ready.");
  return settings;
}

/**
 * Names a thread from its opening message.
 *
 * Runs after the message is on its way, never in front of it: a title is worth
 * a second or two of a cheap model's time, but never a second of the user's.
 * A failure leaves the typed first line in place.
 */
async function nameThread(threadId: string, message: string): Promise<void> {
  const store = requireThreads();
  const config = requireSettings().current();
  if (!config.titleGeneration.enabled) return;

  const thread = store.get(threadId);
  if (!thread) return;

  const manager = requireAgents();
  const agent = titleProvider(config, await manager.list(), thread.agent);
  if (!agent) return;

  const title = await generateTitle(agent, config, message, scratchDirFor(thread.projectId));
  if (!title) return;

  // The user may have renamed it in the meantime; their name wins.
  const current = store.get(threadId);
  if (!current || current.title !== thread.title) return;

  store.rename(threadId, title);
  broadcast("threads", store.index());
}

/**
 * Locates the MCP stdio entry point.
 *
 * Checked against the filesystem instead of resolved through the module system:
 * the main process is bundled, and Electron loads that bundle through the
 * ESM→CJS translator where `createRequire`'s usual anchors are unavailable.
 */
function resolveMcpScript(): string {
  const root = appRoot();

  const candidates = [
    // Packaged, and pnpm's per-package link in development.
    join(root, "node_modules", "@luumen", "code-server", "bin", "luu-code-mcp.js"),
    // Workspace sibling.
    join(root, "..", "server", "bin", "luu-code-mcp.js"),
    // Hoisted workspace root.
    join(root, "..", "..", "node_modules", "@luumen", "code-server", "bin", "luu-code-mcp.js"),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new Error(
      `Could not find the Luu Code MCP entry point. Looked in:\n${candidates.join("\n")}`,
    );
  }

  return found;
}

/**
 * Where the coding agent process runs.
 *
 * Luu Code does not work on the filesystem — the agent reaches the game through
 * Studio — but a child process still needs a working directory. It gets a
 * scratch folder of its own per place, so anything an agent writes on a whim
 * lands there instead of in the user's files.
 */
function scratchDirFor(projectId: string): string {
  const dir = join(app.getPath("userData"), "workspaces", projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes an entry to the open thread and mirrors it to the window. */
function record(entry: TranscriptEntry): void {
  const store = requireThreads();
  const active = store.active();
  if (!active) return;

  const existing = active.items.find((item) => item.id === entry.id);

  if (existing) store.update(active.id, entry.id, entry);
  else store.append(active.id, entry);

  broadcast("transcript", entry);
  broadcast("threads", store.index());
}

async function bootstrap(): Promise<void> {
  threads = new ThreadStore(app.getPath("userData"));
  settings = new SettingsStore(app.getPath("userData"));

  server = await createLuuCodeServer({
    screenshotProvider: createElectronScreenshotProvider(),
  });

  server.bus.subscribe((event: ServerEvent) => {
    broadcast("server-event", event);

    const entry = fromServerEvent(event);
    if (entry) record(entry);

    // Remember which place the conversation was about, so the sidebar can say.
    if (event.type === "session.connected") {
      const active = requireThreads().active();
      if (active && !active.placeName) {
        requireThreads().setMeta(active.id, { placeName: event.session.place.name });
      }
    }
  });

  agents = new AgentManager({
    stateDir: app.getPath("userData"),
    luuCodeHome: process.env.LUU_CODE_HOME,
    mcpScriptPath: resolveMcpScript(),
    onEvent: (event: AgentEvent) => {
      broadcast("agent-event", event);

      if (event.type === "session" && event.sessionId) {
        const active = requireThreads().active();
        // Storing the CLI's own id is what makes a reopened thread resumable
        // rather than a transcript we cannot continue. Spec section 45.
        if (active) requireThreads().setMeta(active.id, { agentSessionId: event.sessionId });
      }

      const active = requireThreads().active();
      const entry = fromAgentEvent(event, (id) => active?.items.find((item) => item.id === id) ?? null);
      if (entry) record(entry);
    },
  });

  const active = requireThreads().active();
  agents.setWorkingDirectory(scratchDirFor(active?.projectId ?? "default"));
  draftSelection = active?.modelSelection ?? null;

  registerIpc();
  await createWindow();

  // Probing `codex app-server` takes a moment, so it happens after the window
  // is up: the catalogue arrives as an event rather than holding the app back.
  void requireAgents()
    .list()
    .then(() => {
      const manager = requireAgents();
      broadcast("catalogue", { models: manager.models(), problem: manager.catalogueProblem() });

      // A draft with no model yet takes the app default.
      if (draftSelection) return;

      const model = defaultModel();
      if (model) {
        draftSelection = createSelection(model.provider, model.slug);
        manager.setModelSelection(draftSelection);
        broadcast("model-selection", draftSelection);
      }
    })
    .catch(() => undefined);
}

function registerIpc(): void {
  ipcMain.handle("snapshot", async (): Promise<HarnessSnapshot> => {
    const local = requireServer();
    const manager = requireAgents();
    const store = requireThreads();

    // `list()` performs discovery on first call, so the catalogue is read after.
    const agents = await manager.list();

    return {
      status: local.status(),
      capabilities: local.capabilities(),
      agents,
      models: manager.models(),
      modelProblem: manager.catalogueProblem(),
      settings: requireSettings().current(),
      session: manager.status(),
      serverPort: local.port,
      mcpCommand: process.platform === "win32" ? "luu-code-mcp.cmd" : "luu-code-mcp",
      platform: process.platform,
      threads: store.index(),
      thread: store.active(),
      modelSelection: activeSelection(),
    };
  });

  ipcMain.handle("refresh-agents", async () => {
    const agents = await requireAgents().list(true);
    broadcast("catalogue", { models: requireAgents().models(), problem: requireAgents().catalogueProblem() });
    return agents;
  });

  ipcMain.handle("update-settings", (_event, patch: Partial<AppSettings>) => {
    const next = requireSettings().update(patch);
    broadcast("settings", next);
    return next;
  });

  ipcMain.handle("reset-settings", () => {
    const next = requireSettings().reset();
    broadcast("settings", next);
    return next;
  });

  ipcMain.handle("window-minimize", () => window?.minimize());
  ipcMain.handle("window-toggle-maximize", () => {
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle("window-close", () => window?.close());
  ipcMain.handle("window-is-maximized", () => window?.isMaximized() ?? false);

  ipcMain.handle("send-message", async (_event, text: string, attachments: Attachment[] = []) => {
    const store = requireThreads();
    const place = requirePlace();
    const manager = requireAgents();

    const selection = activeSelection();
    const agent = findModel(selection?.model)?.provider ?? store.active()?.agent ?? null;
    if (!agent) throw new Error("Pick a model first.");

    // The message is what promotes a draft into a real conversation. Until
    // this point nothing was written and nothing appeared in the sidebar.
    let active = store.active();
    const isFirstMessage = active === null;

    if (!active) {
      active = store.create(place, agent, selection);
      manager.setWorkingDirectory(scratchDirFor(active.projectId));
      broadcast("threads", store.index());
    }

    // The CLI is implied by the model, so it is brought up here rather than
    // being something the user has to remember to start.
    manager.setModelSelection(selection);
    await manager.ensure(agent, active.agent === agent ? active.agentSessionId : null);

    record(userEntry(text, attachments));
    await manager.send(text, attachments);

    if (isFirstMessage) void nameThread(active.id, text);
  });

  ipcMain.handle("interrupt-agent", () => requireAgents().interrupt());

  // ---- Conversation history ------------------------------------------------

  /**
   * Starts a draft rather than a thread.
   *
   * Nothing is written and nothing is listed until the first message: a chat
   * the user opened and abandoned should leave no trace in their history.
   */
  ipcMain.handle("new-thread", async () => {
    const store = requireThreads();
    requirePlace();

    store.clearActive();
    await requireAgents().stop();

    broadcast("threads", store.index());
    return null;
  });

  ipcMain.handle("set-model", (_event, selection: ModelSelection) => {
    const store = requireThreads();
    const active = store.active();

    draftSelection = selection;
    requireAgents().setModelSelection(selection);

    if (active) {
      store.setMeta(active.id, { modelSelection: selection });
      broadcast("threads", store.index());
    }

    return selection;
  });

  /**
   * Picking a model picks the CLI behind it.
   *
   * A GPT model means Codex, a Claude model means Claude Code; asking for both
   * separately was asking the same question twice. Switching provider ends the
   * running session, because the other CLI cannot continue it.
   */
  ipcMain.handle("choose-model", async (_event, slug: string) => {
    const model = findModel(slug);
    if (!model) throw new Error(`Unknown model: ${slug}`);

    const store = requireThreads();
    const manager = requireAgents();
    const selection = createSelection(model.provider, slug);
    const active = store.active();

    if (active && active.agent !== null && active.agent !== model.provider) await manager.stop();

    draftSelection = selection;
    manager.setModelSelection(selection);

    if (active) {
      store.setMeta(active.id, { agent: model.provider, modelSelection: selection });
      manager.setWorkingDirectory(scratchDirFor(active.projectId));
      broadcast("threads", store.index());
    }

    return selection;
  });

  ipcMain.handle("open-thread", async (_event, id: string) => {
    const store = requireThreads();
    const thread = store.select(id);
    if (!thread) return null;

    requireAgents().setWorkingDirectory(scratchDirFor(thread.projectId));
    requireAgents().setModelSelection(thread.modelSelection);

    // The running agent belongs to the thread we just left.
    await requireAgents().stop();

    broadcast("threads", store.index());
    return thread;
  });

  ipcMain.handle("rename-thread", (_event, id: string, title: string) => {
    const store = requireThreads();
    store.rename(id, title);
    const index = store.index();
    broadcast("threads", index);
    return index;
  });

  ipcMain.handle("delete-thread", async (_event, id: string) => {
    const store = requireThreads();
    const wasActive = store.active()?.id === id;

    store.remove(id);
    if (wasActive) await requireAgents().stop();

    const index = store.index();
    broadcast("threads", index);
    return index;
  });

  // ---- Studio --------------------------------------------------------------

  ipcMain.handle("approve-pairing", (_event, sessionId: string) => requireServer().approvePairing(sessionId));
  ipcMain.handle("reject-pairing", (_event, sessionId: string) => requireServer().rejectPairing(sessionId));

  ipcMain.handle("select-session", async (_event, sessionId: string) => {
    await requireServer().execute("session.select", { sessionId }, { origin: "harness" });
  });

  ipcMain.handle("disconnect-session", (_event, sessionId: string) => {
    requireServer().disconnectSession(sessionId);
  });

  ipcMain.handle("set-permission", (_event, group: PermissionGroup, allowed: boolean) => {
    requireServer().settings.setPermission(group, allowed);
    broadcast("server-event", { type: "capabilities", report: requireServer().capabilities() } satisfies ServerEvent);
  });

  ipcMain.handle("execute", (_event, op: string, params: unknown) =>
    requireServer().execute(op, params, { origin: "harness" }),
  );
}

app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox("Luu Code could not start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("before-quit", () => {
  // Anything buffered has to reach disk before the process goes away.
  threads?.flush();
  void agents?.stop();
  void server?.close();
});
