/**
 * A fake bridge, exposed under the name the real one uses.
 *
 * `window.luuCode` is the entire boundary between the renderer and everything
 * else, so replacing it replaces the world — no main process, no local server,
 * no Studio, no CLIs. The renderer cannot tell, which is the point: what ends
 * up in the screenshot is the real UI, not a mock of it.
 *
 * Every method is here whether or not a screenshot needs it. A missing one is
 * not a missing feature, it is a `TypeError` in a component that was about to
 * be photographed.
 */
const { contextBridge, ipcRenderer } = require("electron");
const { SNAPSHOT, OUTPUT, VERSIONS, AGENTS, CHANGES } = require("./mock.cjs");

/** Structured-clone-safe deep copy: contextBridge will not pass shared refs. */
const copy = (value) => JSON.parse(JSON.stringify(value));

const noop = () => () => undefined;
const resolve = (value) => () => Promise.resolve(copy(value));

let onServerEvent = null;

contextBridge.exposeInMainWorld("luuCode", {
  snapshot: resolve(SNAPSHOT),
  refreshAgents: resolve(AGENTS),

  sendMessage: () => Promise.resolve(),
  interruptAgent: () => Promise.resolve(),
  applyModel: (selection) => Promise.resolve(selection),

  // Left live on purpose: the window buttons are drawn by the app, and a
  // screenshot session usually ends with the window being closed.
  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window-close"),
  isWindowMaximized: () => Promise.resolve(false),
  onWindowStateChanged: noop,

  newThread: () => Promise.resolve(null),
  openThread: () => Promise.resolve(copy(SNAPSHOT.thread)),
  renameThread: resolve(SNAPSHOT.threads),
  archiveThread: resolve(SNAPSHOT.threads),
  deleteThread: resolve(SNAPSHOT.threads),

  answerAsk: () => Promise.resolve(),
  cancelAsk: () => Promise.resolve(),
  onAsks: noop,

  selectSession: () => Promise.resolve(),
  disconnectSession: () => Promise.resolve(),
  setPermission: () => Promise.resolve(),
  setToolAllowed: () => Promise.resolve(),

  updateSettings: (patch) => Promise.resolve({ ...copy(SNAPSHOT.settings), ...patch }),
  resetSettings: resolve(SNAPSHOT.settings),

  versionStatus: resolve(VERSIONS),
  checkForUpdate: resolve(VERSIONS),
  downloadUpdate: resolve(VERSIONS),
  installUpdate: resolve(VERSIONS),
  installPlugin: resolve(VERSIONS),
  uninstallPlugin: resolve(VERSIONS),
  openReleases: () => Promise.resolve(),
  revealPluginFolder: () => Promise.resolve(),

  // The dock reads the journal through here rather than from the snapshot, so
  // the Changes tab is empty unless this op answers.
  execute: (op) =>
    Promise.resolve(op === "changes.list" ? { records: copy(CHANGES), total: CHANGES.length, truncated: false } : {}),

  clearStudioOutput: () => Promise.resolve(),

  onServerEvent: (listener) => {
    onServerEvent = listener;
    return () => {
      onServerEvent = null;
    };
  },
  onAgentEvent: noop,
  onAgentStates: noop,
  onThreadsChanged: noop,
  onTranscript: noop,
  onCatalogue: noop,
  onSettingsChanged: noop,
  onVersionStatus: noop,
  onModelSelectionChanged: noop,
});

// Studio output only ever arrives as an event, so it has to be delivered rather
// than declared. One tick after the app has subscribed is soon enough.
setTimeout(() => {
  if (onServerEvent) onServerEvent({ type: "output", sessionId: SNAPSHOT.status.sessions[0].id, entries: copy(OUTPUT) });
}, 300);
