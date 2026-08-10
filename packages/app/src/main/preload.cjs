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

  setModel: (selection) => ipcRenderer.invoke("set-model", selection),
  chooseModel: (slug) => ipcRenderer.invoke("choose-model", slug),

  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onWindowStateChanged: (listener) => subscribe("window-state", listener),

  newThread: () => ipcRenderer.invoke("new-thread"),
  openThread: (id) => ipcRenderer.invoke("open-thread", id),
  renameThread: (id, title) => ipcRenderer.invoke("rename-thread", id, title),
  deleteThread: (id) => ipcRenderer.invoke("delete-thread", id),

  approvePairing: (sessionId) => ipcRenderer.invoke("approve-pairing", sessionId),
  rejectPairing: (sessionId) => ipcRenderer.invoke("reject-pairing", sessionId),
  selectSession: (sessionId) => ipcRenderer.invoke("select-session", sessionId),
  disconnectSession: (sessionId) => ipcRenderer.invoke("disconnect-session", sessionId),
  setPermission: (group, allowed) => ipcRenderer.invoke("set-permission", group, allowed),

  updateSettings: (patch) => ipcRenderer.invoke("update-settings", patch),
  resetSettings: () => ipcRenderer.invoke("reset-settings"),

  execute: (op, params) => ipcRenderer.invoke("execute", op, params),

  onServerEvent: (listener) => subscribe("server-event", listener),
  onAgentEvent: (listener) => subscribe("agent-event", listener),
  onThreadsChanged: (listener) => subscribe("threads", listener),
  onTranscript: (listener) => subscribe("transcript", listener),
  onCatalogue: (listener) => subscribe("catalogue", listener),
  onSettingsChanged: (listener) => subscribe("settings", listener),
  onModelSelectionChanged: (listener) => subscribe("model-selection", listener),
});
