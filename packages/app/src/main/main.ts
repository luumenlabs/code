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
import { PluginInstaller } from "./plugin.js";
import { createElectronScreenshotProvider } from "./screenshot.js";
import { SettingsStore } from "./settings.js";
import { ThreadStore } from "./threads.js";
import { fromAgentEvent, fromServerEvent, userEntry } from "./transcript.js";
import { Updater } from "./updater.js";
import type { AgentEvent, Attachment, TranscriptEntry } from "../shared/agent.js";
import type { HarnessSnapshot } from "../shared/bridge.js";
import { createSelection, defaultModel, findModel } from "../shared/models.js";
import type { ModelSelection } from "../shared/models.js";
import type { AppSettings } from "../shared/settings.js";
import type { PlaceRef } from "../shared/threads.js";
import type { Channel, UpdateStatus, VersionStatus } from "../shared/update.js";

/**
 * The place the agent is currently pointed at.
 *
 * A conversation belongs to a Roblox place, so there is nowhere to file one
 * while Studio is disconnected. Rather than inventing an "unknown" bucket, the
 * app refuses to start a chat until a place is connected.
 */
function connectedPlace(): PlaceRef | null {
  const status = server?.status();
  const session = status?.sessions.find((entry) => entry.active) ?? status?.sessions[0];
  if (!session) return null;

  return {
    // Older plugins do not send one, and neither does a place Studio cannot
    // identify. Both mean the same thing to the thread store.
    identity: session.place.identity ?? null,
    placeId: session.place.placeId,
    name: session.place.name,
  };
}

function requirePlace(): PlaceRef {
  const place = connectedPlace();

  if (!place) {
    throw new Error("Connect Roblox Studio first — a chat belongs to a place.");
  }

  return place;
}

/** What to call each CLI when the transcript has to name one. */
const AGENT_LABEL: Record<import("../shared/agent.js").AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// Resolved from the app root rather than the module path: the main process is
// bundled, so a module-relative path would depend on the bundle layout.
const appRoot = (): string => app.getAppPath();
const isDev = !app.isPackaged;

/**
 * Which build this is.
 *
 * A checkout is a dev build, decided by asking Electron rather than by any
 * convention someone has to remember. Otherwise the nightly workflow sets the
 * variable, and the version is the fallback so a `0.2.0-nightly.3` build
 * carries the nightly identity on its own.
 *
 * The environment variable still wins, so `LUU_CODE_CHANNEL=nightly pnpm dev`
 * shows the nightly identity from source.
 */
function resolveChannel(): Channel {
  const requested = process.env.LUU_CODE_CHANNEL;
  if (requested === "release" || requested === "nightly" || requested === "dev") return requested;

  if (!app.isPackaged) return "dev";
  return app.getVersion().includes("nightly") ? "nightly" : "release";
}

const channel: Channel = resolveChannel();

/**
 * A dev build keeps its own threads, settings, and plugin record.
 *
 * Without this, working on Luu Code means writing to the history of the copy
 * you actually use — and a stray test conversation is indistinguishable from a
 * real one a week later. The installed builds are already separated from each
 * other by their product names.
 *
 * Deliberately not extended to the local server: Studio finds it on a fixed
 * port with a paired token, and moving those would mean re-pairing Studio every
 * time you switch between the dev app and the installed one. Two servers still
 * cannot share the port, which is reported as the conflict it is.
 */
if (channel === "dev") {
  app.setPath("userData", join(app.getPath("appData"), "Luu Code Dev"));
}

/** Blue for release, purple for nightly, amber for a build run from source. */
const ICON_STEM: Record<Channel, string> = {
  release: "icon",
  nightly: "icon-nightly",
  dev: "icon-dev",
};

const WINDOW_TITLE: Record<Channel, string> = {
  release: "Luu Code",
  nightly: "Luu Code Nightly",
  dev: "Luu Code (dev)",
};

/** Taskbar grouping and pinned shortcuts. One identity per channel. */
const APP_USER_MODEL_ID: Record<Channel, string> = {
  release: "dev.luumen.code",
  nightly: "dev.luumen.code.nightly",
  dev: "dev.luumen.code.dev",
};

/**
 * The app icon, copied out of the repo's asset bank at build time.
 *
 * Windows wants the .ico for the taskbar, everything else takes the PNG.
 * Missing icons are not worth failing to start over, so this can return null.
 */
function iconPath(): string | null {
  const extension = process.platform === "win32" ? "ico" : "png";
  const path = join(appRoot(), "dist", "icons", `${ICON_STEM[channel]}.${extension}`);
  return existsSync(path) ? path : null;
}

let window: BrowserWindow | null = null;
let server: LuuCodeServer | null = null;
let agents: AgentManager | null = null;
let threads: ThreadStore | null = null;
let settings: SettingsStore | null = null;
let updater: Updater | null = null;
let plugin: PluginInstaller | null = null;
/** Resolved once at startup, then reused for both the agents and the UI. */
let mcpScript = "";

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
  const icon = iconPath();

  window = new BrowserWindow({
    // Wide enough that the thread list, the conversation, and the Studio dock
    // can all be open without the conversation being squeezed.
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#171717",
    title: WINDOW_TITLE[channel],
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    // The window chrome is part of the app: the title bar carries the Studio
    // connection state, which the user needs visible at all times.
    // No titleBarOverlay: Windows only lets it take two colours, so it never
    // matches the rest of the chrome. The app draws its own controls instead.
    titleBarStyle: "hidden",
    // Centred in the title bar; move it and this moves with it.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 10 } } : {}),
    webPreferences: {
      preload: join(appRoot(), "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The renderer's <title> is applied over the window title the moment the page
  // loads, which would put all three channels back on the same name in the
  // taskbar and the window switcher. The title set above is the one that means
  // something, so the document's is refused.
  window.on("page-title-updated", (event) => event.preventDefault());

  const contents = window.webContents;

  // External links belong in the user's browser, not in a window that can talk
  // to Roblox Studio.
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  /**
   * Nothing navigates this window away from the app.
   *
   * The handler above only sees `window.open` and `target="_blank"`; a plain
   * link click is a same-window navigation and would replace the renderer —
   * with no way back, since the app has no address bar. That became reachable
   * the moment the transcript started rendering Markdown, where the link text
   * and the href are both written by a model. Links are marked `_blank` so they
   * route to the browser; this is the backstop for everything else.
   */
  contents.on("will-navigate", (event, url) => {
    if (url === contents.getURL()) return;
    event.preventDefault();
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
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
 * Runs alongside the conversation, never in front of it: this is a separate
 * one-shot call to a small model, so it has no reason to hold up the answer the
 * user is actually waiting for. A failure leaves the typed first line in place.
 */
async function nameThread(threadId: string, message: string): Promise<void> {
  const store = requireThreads();
  const config = requireSettings().current();
  if (!config.titleGeneration.enabled) return;

  const thread = store.get(threadId);
  if (!thread) return;

  const manager = requireAgents();
  const agent = titleProvider(config, await manager.list());
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
 *
 * A packaged build carries its own bundled copy in resources, outside the asar,
 * so it is a real file a terminal can point at. That copy is the shipped
 * `luu-code-mcp`: there is no npm package to install and no second version to
 * drift.
 */
function resolveMcpScript(): string {
  const root = appRoot();

  const candidates = [
    // Shipped with the app, outside the asar so it can be spawned directly.
    join(process.resourcesPath, "mcp", "luu-code-mcp.cjs"),
    join(root, "dist", "mcp", "luu-code-mcp.cjs"),
    // pnpm's per-package link in development.
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
 * The command that runs this build's MCP server from a terminal.
 *
 * It points at the app's own binary, run as plain Node, and at the script that
 * shipped with it — so it needs nothing installed and cannot be a different
 * version from the app that wrote it.
 */
function mcpCommandLine(): string {
  const quote = (value: string): string => (/[\s"]/.test(value) ? `"${value}"` : value);
  return `${quote(process.execPath)} ${quote(mcpScript)}`;
}

function requireUpdater(): Updater {
  if (!updater) throw new Error("The updater is not ready.");
  return updater;
}

function requirePlugin(): PluginInstaller {
  if (!plugin) throw new Error("The plugin installer is not ready.");
  return plugin;
}

function versionStatus(): VersionStatus {
  return {
    update: requireUpdater().current(),
    plugin: requirePlugin().status(),
    mcpCommand: mcpCommandLine(),
  };
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


/**
 * Writes an entry to the thread it belongs to and mirrors it to the window.
 *
 * The thread is named, never inferred from whichever chat happens to be open:
 * conversations run in parallel, so an entry that arrives while the user is
 * reading something else still belongs to the one that produced it.
 */
function record(threadId: string, entry: TranscriptEntry): void {
  const store = requireThreads();
  const thread = store.get(threadId);
  if (!thread) return;

  const existing = thread.items.find((item) => item.id === entry.id);

  if (existing) store.update(threadId, entry.id, entry);
  else store.append(threadId, entry);

  broadcast("transcript", { threadId, entry });
  broadcast("threads", store.index());
}

async function bootstrap(): Promise<void> {
  // Windows groups taskbar buttons and picks the icon by this id; without it,
  // a development run shows up as Electron. Each channel gets its own, so no
  // two ever share a taskbar button or a pinned shortcut.
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID[channel]);
  }

  // macOS takes the dock icon from the bundle once packaged, but not before.
  if (process.platform === "darwin" && app.dock) {
    const icon = iconPath();
    if (icon) app.dock.setIcon(icon);
  }

  threads = new ThreadStore(app.getPath("userData"));
  settings = new SettingsStore(app.getPath("userData"));

  mcpScript = resolveMcpScript();

  // The installer first: the updater reports through a callback that describes
  // both, and an update event can arrive the moment it is constructed.
  plugin = new PluginInstaller(channel, app.getPath("userData"), appRoot());

  updater = new Updater(channel, (status: UpdateStatus) =>
    broadcast("update", { update: status, plugin: requirePlugin().status(), mcpCommand: mcpCommandLine() }),
  );

  // Only if the user has already said yes. The first install is always a
  // button press; this is what keeps it matching afterwards.
  if (requireSettings().current().plugin.autoInstall && plugin.needsInstall()) plugin.install();

  server = await createLuuCodeServer({
    screenshotProvider: createElectronScreenshotProvider(),
  });

  server.bus.subscribe((event: ServerEvent) => {
    broadcast("server-event", event);

    /**
     * A Roblox operation belongs to whoever asked for it.
     *
     * Agents label their calls with the conversation they are serving, so the
     * usual case is exact. What is left over is the manual controls in the
     * dock and an MCP client the user wired up themselves — neither carries a
     * chat, and both belong in front of whoever is looking.
     */
    const entry = fromServerEvent(event);
    if (entry) {
      const owner = (entry.kind === "activity" ? entry.activity.chat : null) ?? requireThreads().active()?.id;
      if (owner) record(owner, entry);
    }

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
    mcpScriptPath: mcpScript,
    onEvent: (threadId: string, event: AgentEvent) => {
      broadcast("agent-event", { threadId, event });

      const store = requireThreads();
      const thread = store.get(threadId);
      if (!thread) return;

      if (event.type === "session" && event.sessionId) {
        // Storing the CLI's own id is what makes a reopened thread resumable
        // rather than a transcript we cannot continue. Spec section 45.
        store.setMeta(threadId, { agentSessionId: event.sessionId });
      }

      const entry = fromAgentEvent(event, (id) => thread.items.find((item) => item.id === id) ?? null);
      if (entry) record(threadId, entry);
    },
    onStates: (states) => broadcast("agent-states", states),
  });

  draftSelection = requireThreads().active()?.modelSelection ?? null;

  registerIpc();
  await createWindow();

  // Checks only, and never in front of the window opening.
  requireUpdater().start();

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
        // Only the draft: a live session already has the model it was started
        // on, and the app default has no business retargeting it.
        draftSelection = createSelection(model.provider, model.slug);
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
      session: manager.status(store.active()?.id ?? null),
      agentStates: manager.states(),
      serverPort: local.port,
      mcpCommand: mcpCommandLine(),
      versions: versionStatus(),
      platform: process.platform,
      channel,
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

    // Turning the switch on is the permission, so it acts immediately rather
    // than waiting for the next launch to do what was just asked for.
    if (next.plugin.autoInstall && requirePlugin().needsInstall()) {
      requirePlugin().install();
      broadcast("update", versionStatus());
    }

    return next;
  });

  ipcMain.handle("reset-settings", () => {
    const next = requireSettings().reset();
    broadcast("settings", next);
    return next;
  });

  // ---- Versions ------------------------------------------------------------

  ipcMain.handle("version-status", () => versionStatus());

  ipcMain.handle("check-update", async () => {
    await requireUpdater().check();
    return versionStatus();
  });

  ipcMain.handle("download-update", async () => {
    await requireUpdater().download();
    return versionStatus();
  });

  ipcMain.handle("install-update", () => {
    requireUpdater().install();
    return versionStatus();
  });

  ipcMain.handle("install-plugin", () => {
    requirePlugin().install();
    const status = versionStatus();
    broadcast("update", status);
    return status;
  });

  ipcMain.handle("uninstall-plugin", () => {
    requirePlugin().uninstall();
    const status = versionStatus();
    broadcast("update", status);
    return status;
  });

  ipcMain.handle("open-releases", () => shell.openExternal(requireUpdater().current().releaseUrl));

  ipcMain.handle("reveal-plugin-folder", () => {
    const directory = requirePlugin().status().directory;
    if (directory) void shell.openPath(directory);
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
      broadcast("threads", store.index());
    }

    // The message goes into the transcript before the CLI is touched, so it
    // appears the moment it is sent rather than once the agent has started.
    record(active.id, userEntry(text, attachments));

    // Naming runs beside the turn, not before it. It is a separate call to a
    // separate CLI, so the only thing serialising the two ever bought was a
    // slower first answer.
    if (isFirstMessage) void nameThread(active.id, text);

    // The CLI is implied by the model, so it is brought up here rather than
    // being something the user has to remember to start. Resuming is only
    // offered to the CLI that produced the id — `agentSessionId` is cleared
    // whenever the provider changes, so this cannot hand a Codex id to Claude.
    await manager.ensure(active.id, {
      agent,
      cwd: scratchDirFor(active.projectId),
      modelSelection: selection,
      resumeSessionId: active.agent === agent ? active.agentSessionId : null,
    });

    await manager.send(active.id, text, attachments);
  });

  /** Stops the turn in the chat the user is looking at, and only that one. */
  ipcMain.handle("interrupt-agent", () => requireAgents().interrupt(requireThreads().active()?.id ?? null));

  // ---- Conversation history ------------------------------------------------

  /**
   * Starts a draft rather than a thread.
   *
   * Nothing is written and nothing is listed until the first message: a chat
   * the user opened and abandoned should leave no trace in their history.
   *
   * Whatever was running keeps running. Starting a new chat is not a request to
   * abandon the last one.
   */
  ipcMain.handle("new-thread", async () => {
    const store = requireThreads();
    requirePlace();

    store.clearActive();

    broadcast("threads", store.index());
    return null;
  });

  /**
   * The model and everything set on it, applied as one thing.
   *
   * A model, its reasoning level, and its context window are a single choice —
   * splitting them across two calls only meant the renderer had to know which
   * one to make. Picking a model also picks the CLI behind it: a GPT model
   * means Codex, a Claude model means Claude Code.
   *
   * Staying on the same CLI changes the model on the live session, so the
   * conversation carries on. Changing CLI cannot: the other one has no way to
   * continue a session it did not create. That ends this chat's session and
   * clears the stored id — handing a Codex id to Claude Code is what used to
   * make switching provider mid-chat look impossible — and the transcript says
   * so, because losing the agent's context without being told is worse than
   * being refused.
   */
  ipcMain.handle("apply-model", async (_event, selection: ModelSelection) => {
    const model = findModel(selection.model);
    if (!model) throw new Error(`Unknown model: ${selection.model}`);

    const store = requireThreads();
    const manager = requireAgents();
    const active = store.active();

    draftSelection = selection;

    if (!active) return selection;

    const switching = active.agent !== null && active.agent !== model.provider;

    if (switching) {
      await manager.stop(active.id);
      store.setMeta(active.id, { agentSessionId: null });

      record(active.id, {
        kind: "notice",
        id: `n_switch_${Date.now().toString(36)}`,
        at: Date.now(),
        tone: "info",
        text: `Switched to ${AGENT_LABEL[model.provider]}. The transcript stays, but it starts fresh — ${AGENT_LABEL[active.agent!]} cannot hand over its context.`,
      });
    }

    store.setMeta(active.id, { agent: model.provider, modelSelection: selection });
    manager.setModelSelection(active.id, selection);
    broadcast("threads", store.index());

    return selection;
  });

  /**
   * Opens a conversation. Nothing is stopped.
   *
   * This used to end the running session, on the reasoning that it belonged to
   * the thread being left — but it did not end it honestly: the state went to
   * "stopped" while the CLI was still draining, so a chat that was very much
   * still working looked finished, and its remaining output was filed against
   * whichever chat had just been opened. Sessions are per conversation now, and
   * opening one is only a change of view.
   */
  ipcMain.handle("open-thread", async (_event, id: string) => {
    const store = requireThreads();
    const thread = store.select(id);
    if (!thread) return null;

    broadcast("threads", store.index());
    return thread;
  });

  ipcMain.handle("archive-thread", (_event, id: string, archived: boolean) => {
    const store = requireThreads();
    store.setArchived(id, archived);
    const index = store.index();
    broadcast("threads", index);
    return index;
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

    store.remove(id);
    // Deleting a conversation does end its session — there is nothing left for
    // it to write into.
    await requireAgents().discard(id);

    const index = store.index();
    broadcast("threads", index);
    return index;
  });

  // ---- Studio --------------------------------------------------------------

  ipcMain.handle("approve-pairing", (_event, sessionId: string) => requireServer().approvePairing(sessionId));
  ipcMain.handle("reject-pairing", (_event, sessionId: string) => requireServer().rejectPairing(sessionId));

  ipcMain.handle("select-session", async (_event, sessionId: string, chat?: string) => {
    await requireServer().execute("session.select", { sessionId }, { origin: "harness", ...(chat ? { chat } : {}) });
  });

  ipcMain.handle("disconnect-session", (_event, sessionId: string) => {
    requireServer().disconnectSession(sessionId);
  });

  ipcMain.handle("set-permission", (_event, group: PermissionGroup, allowed: boolean) => {
    requireServer().settings.setPermission(group, allowed);
    broadcast("server-event", { type: "capabilities", report: requireServer().capabilities() } satisfies ServerEvent);
  });

  // The chat comes along so a button in the dock hits the same Studio window
  // the conversation beside it is working in, rather than the selected one.
  ipcMain.handle("execute", (_event, op: string, params: unknown, chat?: string) =>
    requireServer().execute(op, params, { origin: "harness", ...(chat ? { chat } : {}) }),
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
  updater?.stop();
  // Every CLI the app started, not just the one on screen.
  void agents?.stopAll();
  void server?.close();
});
