// Preload bridge. Deliberately plain CommonJS: preload runs before the app's
// module graph and this file only needs to expose a fixed, narrow API.
//
// The renderer gets exactly the operations listed here and no direct access to
// Node, the filesystem, or the Roblox transport.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("luuCode", {
  snapshot: () => ipcRenderer.invoke("snapshot"),
  refreshAgents: () => ipcRenderer.invoke("refresh-agents"),

  sendMessage: (text, attachments) => ipcRenderer.invoke("send-message", text, attachments ?? []),
  interruptAgent: () => ipcRenderer.invoke("interrupt-agent"),

  applyModel: (selection) => ipcRenderer.invoke("apply-model", selection),

  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onWindowStateChanged: (listener) => subscribe("window-state", listener),

  newThread: () => ipcRenderer.invoke("new-thread"),
  openThread: (id) => ipcRenderer.invoke("open-thread", id),
  renameThread: (id, title) => ipcRenderer.invoke("rename-thread", id, title),
  archiveThread: (id, archived) => ipcRenderer.invoke("archive-thread", id, archived),
  deleteThread: (id) => ipcRenderer.invoke("delete-thread", id),

  approvePairing: (sessionId) => ipcRenderer.invoke("approve-pairing", sessionId),
  rejectPairing: (sessionId) => ipcRenderer.invoke("reject-pairing", sessionId),
  selectSession: (sessionId, chat) => ipcRenderer.invoke("select-session", sessionId, chat),
  disconnectSession: (sessionId) => ipcRenderer.invoke("disconnect-session", sessionId),
  setPermission: (group, allowed) => ipcRenderer.invoke("set-permission", group, allowed),
  setToolAllowed: (op, allowed) => ipcRenderer.invoke("set-tool-allowed", op, allowed),

  updateSettings: (patch) => ipcRenderer.invoke("update-settings", patch),
  resetSettings: () => ipcRenderer.invoke("reset-settings"),

  versionStatus: () => ipcRenderer.invoke("version-status"),
  checkForUpdate: () => ipcRenderer.invoke("check-update"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  installPlugin: () => ipcRenderer.invoke("install-plugin"),
  uninstallPlugin: () => ipcRenderer.invoke("uninstall-plugin"),
  openReleases: () => ipcRenderer.invoke("open-releases"),
  revealPluginFolder: () => ipcRenderer.invoke("reveal-plugin-folder"),

  execute: (op, params, chat) => ipcRenderer.invoke("execute", op, params, chat),
  clearStudioOutput: (chat) => ipcRenderer.invoke("clear-output", chat),

  onServerEvent: (listener) => subscribe("server-event", listener),
  onAgentEvent: (listener) => subscribe("agent-event", listener),
  onAgentStates: (listener) => subscribe("agent-states", listener),
  onThreadsChanged: (listener) => subscribe("threads", listener),
  onTranscript: (listener) => subscribe("transcript", listener),
  onCatalogue: (listener) => subscribe("catalogue", listener),
  onSettingsChanged: (listener) => subscribe("settings", listener),
  onVersionStatus: (listener) => subscribe("update", listener),
  onModelSelectionChanged: (listener) => subscribe("model-selection", listener),
});
