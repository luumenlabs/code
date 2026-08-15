/**
 * Luu Code — Electron main process.
 *
 * Starts the local server in-process, registers the screenshot provider, owns
 * the agent session and the conversation history, and serves the window.
 * Closing the app closes the server it started; `luu-code serve` starts a
 * standalone one.
 */
import { BrowserWindow, Menu, MenuItem, app, dialog, ipcMain, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLuuCodeServer } from "@luumen/code-server";
import type { LuuCodeServer } from "@luumen/code-server";
import { LuuCodeError } from "@luumen/code-protocol";
import type { AskAnswer, AskOutcome, AskRequest, ChangeRecord, Op, PermissionGroup, ServerEvent } from "@luumen/code-protocol";
import { AgentManager } from "./agents/manager.js";
import type { AgentRules } from "./agents/briefing.js";
import { generateTitle, titleProvider } from "./agents/title.js";
import { PluginInstaller } from "./plugin.js";
import { createElectronDesktopCaptureProvider } from "./screenshot.js";
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

/** The place the agent is pointed at. Null while Studio is disconnected. */
function connectedPlace(): PlaceRef | null {
  const status = server?.status();
  const session = status?.sessions.find((entry) => entry.active) ?? status?.sessions[0];
  if (!session) return null;

  return {
    // Older plugins and places Studio cannot identify both send none.
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

/**
 * Both layers of rules, for the agent's briefing. The place's half is best
 * effort — a missing document, a lost Studio, or a plugin too old for the
 * operation all start the session without it rather than failing the message.
 */
async function readRules(chat: string): Promise<AgentRules> {
  const global = requireSettings().current().globalRules.trim();

  try {
    const result = (await requireServer().execute("rules.get", {}, { origin: "internal", chat, silent: true })) as {
      text: string | null;
    };
    return { global: global || null, place: result.text };
  } catch {
    return { global: global || null, place: null };
  }
}

/** What to call each CLI when the transcript has to name one. */
const AGENT_LABEL: Record<import("../shared/agent.js").AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  ollama: "Ollama",
};

// The main process is bundled, so a module-relative path would follow whatever
// layout the bundler chose.
const appRoot = (): string => app.getAppPath();
const isDev = !app.isPackaged;

/**
 * Which build this is. `LUU_CODE_CHANNEL` wins, then an unpackaged checkout is
 * dev, then a version containing `nightly` is nightly.
 */
function resolveChannel(): Channel {
  const requested = process.env.LUU_CODE_CHANNEL;
  if (requested === "release" || requested === "nightly" || requested === "dev") return requested;

  if (!app.isPackaged) return "dev";
  return app.getVersion().includes("nightly") ? "nightly" : "release";
}

const channel: Channel = resolveChannel();

/**
 * A dev build keeps its own threads, settings, and plugin record, so working on
 * Luu Code never writes into the history of the copy you use. The local server
 * is not separated — Studio finds it on a fixed port.
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

/** The app icon. Null when the build has none — not worth failing to start over. */
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
 * Questions waiting on the user, by ask id. The agent's tool call is held open
 * while one lives, so every path out has to settle exactly once.
 */
const asks = new Map<string, { request: AskRequest; settle: (outcome: AskOutcome) => void }>();

/** Every unanswered question, by the conversation it is waiting in. */
function pendingAsks(): Record<string, AskRequest[]> {
  const byThread: Record<string, AskRequest[]> = {};

  for (const { request } of asks.values()) {
    (byThread[request.chat] ??= []).push(request);
  }

  return byThread;
}

function broadcastAsks(): void {
  broadcast("asks", pendingAsks());
}

/**
 * Ends every question waiting on a conversation, called when the turn that
 * asked stops. Otherwise the form stays up and answering it resolves nothing.
 */
function abandonAsks(threadId: string): void {
  // `settle` owns the removal — it uses the delete as its once-only guard.
  for (const pending of [...asks.values()]) {
    if (pending.request.chat === threadId) pending.settle({ status: "expired" });
  }
}

/** The model the next message will use, while the chat is still a draft. */
let draftSelection: ModelSelection | null = null;

/** The open thread's model, or the draft's. */
function activeSelection(): ModelSelection | null {
  return threads?.active()?.modelSelection ?? draftSelection;
}

function broadcast(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload);
}

/**
 * Chromium marks misspellings but leaves the correction menu to the app, and
 * defaults the dictionary to en-US. macOS owns both itself; the setter throws.
 */
function configureSpellchecker(contents: Electron.WebContents): void {
  if (process.platform !== "darwin") {
    const { session } = contents;
    const supported = new Set(session.availableSpellCheckerLanguages);
    const wanted = app.getPreferredSystemLanguages().filter((language) => supported.has(language));

    // An empty list turns the spellchecker off, so no match keeps the default.
    if (wanted.length > 0) {
      try {
        session.setSpellCheckerLanguages(wanted);
      } catch {
        // A language Chromium lists but refuses to load. The default stays.
      }
    }
  }

  contents.on("context-menu", (_event, params) => {
    const menu = new Menu();

    for (const suggestion of params.dictionarySuggestions) {
      menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
    }

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: "separator" }));
      menu.append(
        new MenuItem({
          label: "Add to dictionary",
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        }),
      );
      menu.append(new MenuItem({ type: "separator" }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: "cut", enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: "copy", enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: "paste", enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ role: "selectAll" }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: "copy" }));
    }

    if (menu.items.length > 0) menu.popup();
  });
}

async function createWindow(): Promise<void> {
  const icon = iconPath();

  window = new BrowserWindow({
    // Wide enough for the thread list, the conversation, and the Studio dock at once.
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#171717",
    title: WINDOW_TITLE[channel],
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    // The title bar carries the Studio connection state, so the app draws its
    // own. No titleBarOverlay: Windows only lets it take two colours.
    titleBarStyle: "hidden",
    // Centred in the title bar; move it and this moves with it.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 10 } } : {}),
    webPreferences: {
      preload: join(appRoot(), "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The composer is the one place in the app the user writes prose.
      spellcheck: true,
    },
  });

  // The renderer's <title> would put all three channels back on one name in the
  // taskbar and the window switcher.
  window.on("page-title-updated", (event) => event.preventDefault());

  const contents = window.webContents;

  configureSpellchecker(contents);

  // External links belong in the user's browser, not in a window that can talk
  // to Roblox Studio.
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  /**
   * Nothing navigates this window away from the app. The handler above only
   * sees `window.open`; a plain link click would replace the renderer, and the
   * transcript renders Markdown whose hrefs a model wrote.
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
 * Names a thread from its opening message. Runs alongside the turn, never in
 * front of it. A failure leaves the typed first line in place.
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
 * Locates the MCP stdio entry point. Checked against the filesystem instead of
 * resolved through the module system: the main process is bundled, and
 * Electron's ESM→CJS translator leaves `createRequire`'s anchors unavailable.
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
 * The command that runs this build's MCP server from a terminal. It points at
 * the app's own binary and the script that shipped with it, so it needs nothing
 * installed and cannot be a different version.
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
 * Where the coding agent process runs. Luu Code does not work on the
 * filesystem, but a child process still needs a working directory — it gets a
 * scratch folder per place so nothing an agent writes lands in the user's files.
 */
function scratchDirFor(projectId: string): string {
  const dir = join(app.getPath("userData"), "workspaces", projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}


/**
 * Writes an entry to the thread it belongs to and mirrors it to the window. The
 * thread is named, never inferred from whichever chat is open — conversations
 * run in parallel.
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
  // Windows groups taskbar buttons and picks the icon by this id; without it a
  // dev run shows up as Electron.
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

  // Before the updater: its callback describes both, and an update event can
  // arrive the moment it is constructed.
  plugin = new PluginInstaller(channel, app.getPath("userData"), appRoot());

  updater = new Updater(channel, (status: UpdateStatus) =>
    broadcast("update", { update: status, plugin: requirePlugin().status(), mcpCommand: mcpCommandLine() }),
  );

  // Only once the user has said yes; the first install is always a button press.
  if (requireSettings().current().plugin.autoInstall && plugin.needsInstall()) plugin.install();

  server = await createLuuCodeServer({
    desktopCaptureProvider: createElectronDesktopCaptureProvider(),
  });

  /**
   * A question goes to the composer of the conversation that asked, and the
   * agent's tool call waits here until it comes back. Live state, not a
   * transcript entry: a form restored from disk answers into a turn that ended.
   */
  server.setAskHost((request) => {
    const store = requireThreads();

    if (!store.get(request.chat)) {
      throw new LuuCodeError("ASK_UNAVAILABLE", "That conversation is no longer open.");
    }

    return new Promise<AskOutcome>((resolve) => {
      const settle = (outcome: AskOutcome): void => {
        // The delete is the once-only guard: first path here owns the outcome.
        if (!asks.delete(request.id)) return;

        clearTimeout(timer);
        broadcastAsks();
        resolve(outcome);
      };

      const timer = setTimeout(() => settle({ status: "expired" }), Math.max(0, request.expiresAt - Date.now()));

      asks.set(request.id, { request, settle });
      broadcastAsks();
    });
  });

  server.bus.subscribe((event: ServerEvent) => {
    broadcast("server-event", event);

    /**
     * A Roblox operation belongs to whoever asked for it. Agents label their
     * calls with the conversation they serve; the dock and an external MCP
     * client carry no chat, so those go in front of whoever is looking.
     */
    const entry = fromServerEvent(event);
    if (entry) {
      const owner = (entry.kind === "activity" ? entry.activity.chat : null) ?? requireThreads().active()?.id;
      if (owner) record(owner, entry);
    }

    // Remembered so the sidebar can name the place after Studio has gone.
    if (event.type === "session.connected") {
      const active = requireThreads().active();
      if (active && !active.placeName) {
        requireThreads().setMeta(active.id, { placeName: event.session.place.name });
      }
    }

    /**
     * A copy of the diff goes to the conversation that asked for it. The
     * server's own journal is in memory and per Studio window, so the
     * transcript is what survives. Filed like the activity row above it.
     */
    if (event.type === "changes") {
      const store = requireThreads();
      const active = store.active()?.id ?? null;
      const byThread = new Map<string, ChangeRecord[]>();

      for (const record of event.records) {
        const owner = record.chat ?? active;
        if (!owner) continue;

        const bucket = byThread.get(owner);
        if (bucket) bucket.push(record);
        else byThread.set(owner, [record]);
      }

      for (const [threadId, records] of byThread) store.recordChanges(threadId, records);
    }

    /**
     * A place can be renamed under us — the plugin reports `game.Name` first
     * and the published name once Roblox answers. The sidebar is keyed on
     * identity, so the heading follows.
     */
    if (event.type === "status") {
      const store = requireThreads();
      const renamed = event.status.sessions
        .map((session) =>
          store.describe({
            identity: session.place.identity ?? null,
            placeId: session.place.placeId,
            name: session.place.name,
          }),
        )
        .some(Boolean);

      if (renamed) broadcast("threads", store.index());
    }
  });

  agents = new AgentManager({
    stateDir: app.getPath("userData"),
    luuCodeHome: process.env.LUU_CODE_HOME,
    mcpScriptPath: mcpScript,
    onEvent: (threadId: string, event: AgentEvent) => {
      broadcast("agent-event", { threadId, event });

      // The turn that asked has stopped, so nothing is listening for an answer.
      if (event.type === "state" && (event.state === "idle" || event.state === "stopped" || event.state === "error")) {
        abandonAsks(threadId);
      }

      const store = requireThreads();
      const thread = store.get(threadId);
      if (!thread) return;

      if (event.type === "session" && event.sessionId) {
        // The CLI's own id is what makes a reopened thread resumable.
        store.setMeta(threadId, { agentSessionId: event.sessionId });
      }

      const entry = fromAgentEvent(event, {
        byId: (id) => thread.items.find((item) => item.id === id) ?? null,
        // The operation is filed by the server's own event, so the transcript
        // is the only place that knows whether one arrived.
        hasActivity: (op, since) =>
          thread.items.some((item) => item.kind === "activity" && item.activity.op === op && item.at >= since),
      });
      if (entry) record(threadId, entry);
    },
    onStates: (states) => broadcast("agent-states", states),
  });

  draftSelection = requireThreads().active()?.modelSelection ?? null;

  registerIpc();
  await createWindow();

  // Checks only, and never in front of the window opening.
  requireUpdater().start();

  // Probing `codex app-server` takes a moment, so the catalogue arrives as an
  // event once the window is already up.
  void requireAgents()
    .list()
    .then(() => {
      const manager = requireAgents();
      broadcast("catalogue", { models: manager.models(), problem: manager.catalogueProblem() });

      // A draft with no model yet takes the app default.
      if (draftSelection) return;

      const model = defaultModel();
      if (model) {
        // Only the draft: a live session keeps the model it was started on.
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
      pendingAsks: pendingAsks(),
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

    // Turning the switch on is the permission, so it acts now, not at next launch.
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

    // The message is what promotes a draft into a real conversation.
    let active = store.active();
    const isFirstMessage = active === null;

    if (!active) {
      active = store.create(place, agent, selection);
      broadcast("threads", store.index());
    }

    // Into the transcript before the CLI is touched, so the message appears the
    // moment it is sent.
    record(active.id, userEntry(text, attachments));

    // Naming runs beside the turn: a separate call to a separate CLI.
    if (isFirstMessage) void nameThread(active.id, text);

    // Resuming is only offered to the CLI that produced the id —
    // `agentSessionId` is cleared whenever the provider changes.
    await manager.ensure(active.id, {
      agent,
      cwd: scratchDirFor(active.projectId),
      modelSelection: selection,
      resumeSessionId: active.agent === agent ? active.agentSessionId : null,
      rules: () => readRules(active.id),
    });

    await manager.send(active.id, text, attachments);
  });

  /** Stops the turn in the chat the user is looking at, and only that one. */
  ipcMain.handle("interrupt-agent", () => requireAgents().interrupt(requireThreads().active()?.id ?? null));

  // ---- Conversation history ------------------------------------------------

  /**
   * Starts a draft rather than a thread. Nothing is written or listed until the
   * first message, and whatever was running keeps running.
   */
  ipcMain.handle("new-thread", async () => {
    const store = requireThreads();
    requirePlace();

    store.clearActive();

    broadcast("threads", store.index());
    return null;
  });

  /**
   * The model, its reasoning level, and its context window, applied as one
   * choice. Picking a model picks the CLI behind it.
   *
   * Staying on the same provider changes the model on the live session.
   * Changing provider is refused here as well as greyed out in the picker, so a
   * stale window cannot strand a chat on an agent that has never seen it. See
   * `lockedProvider` in `shared/threads.ts`.
   */
  ipcMain.handle("apply-model", async (_event, selection: ModelSelection) => {
    const model = findModel(selection.model);
    if (!model) throw new Error(`Unknown model: ${selection.model}`);

    const store = requireThreads();
    const manager = requireAgents();
    const active = store.active();

    // Before anything is written: a refused switch leaves this conversation and
    // the next new chat exactly as they were.
    if (active?.agent && active.agent !== model.provider) {
      throw new Error(
        `This chat is running on ${AGENT_LABEL[active.agent]}, and ${AGENT_LABEL[model.provider]} cannot continue a conversation it did not start. Start a new chat to use ${model.name}.`,
      );
    }

    draftSelection = selection;

    if (!active) return selection;

    store.setMeta(active.id, { agent: model.provider, modelSelection: selection });
    manager.setModelSelection(active.id, selection);
    broadcast("threads", store.index());

    return selection;
  });

  /** Opens a conversation. Sessions are per conversation, so nothing is stopped. */
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

    // A question in a deleted conversation has nobody to answer it.
    abandonAsks(id);

    store.remove(id);
    // Deleting does end the session — there is nothing left to write into.
    await requireAgents().discard(id);

    const index = store.index();
    broadcast("threads", index);
    return index;
  });

  // ---- Questions -----------------------------------------------------------

  ipcMain.handle("answer-ask", (_event, id: string, answers: AskAnswer[]) => {
    asks.get(id)?.settle({ status: "answered", answers });
  });

  /**
   * Dismissing a question stops the turn as well as ending the wait. The agent
   * asked because it could not continue without knowing.
   */
  ipcMain.handle("cancel-ask", (_event, id: string) => {
    const pending = asks.get(id);
    if (!pending) return;

    const { chat } = pending.request;
    pending.settle({ status: "cancelled" });
    requireAgents().interrupt(chat);
  });

  // ---- Studio --------------------------------------------------------------


  ipcMain.handle("select-session", async (_event, sessionId: string, chat?: string) => {
    await requireServer().execute("session.select", { sessionId }, { origin: "harness", ...(chat ? { chat } : {}) });
  });

  ipcMain.handle("disconnect-session", (_event, sessionId: string) => {
    requireServer().disconnectSession(sessionId);
  });

  // Through the server rather than the settings store, so the bus event reaches
  // the MCP children too — each holds a tool list it fetched when it connected.
  ipcMain.handle("set-permission", (_event, group: PermissionGroup, allowed: boolean) => {
    requireServer().setPermission(group, allowed);
  });

  ipcMain.handle("set-tool-allowed", (_event, op: Op, allowed: boolean) => {
    requireServer().setToolAllowed(op, allowed);
  });

  // The chat picks the Studio window, so a dock button hits the one the
  // conversation beside it is working in.
  ipcMain.handle("execute", (_event, op: string, params: unknown, chat?: string) =>
    requireServer().execute(op, params, { origin: "harness", ...(chat ? { chat } : {}) }),
  );

  // Its own channel because it is silent: the user pressed Clear, so the
  // transcript has nothing to record.
  ipcMain.handle("clear-output", async (_event, chat?: string) => {
    await requireServer().execute("output.clear", {}, { origin: "harness", silent: true, ...(chat ? { chat } : {}) });
  });
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
