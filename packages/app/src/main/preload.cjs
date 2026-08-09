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

  startAgent: (id) => ipcRenderer.invoke("start-agent", id),
  stopAgent: () => ipcRenderer.invoke("stop-agent"),
  sendMessage: (text) => ipcRenderer.invoke("send-message", text),
  interruptAgent: () => ipcRenderer.invoke("interrupt-agent"),

  setModel: (selection) => ipcRenderer.invoke("set-model", selection),

  newThread: () => ipcRenderer.invoke("new-thread"),
  openThread: (id) => ipcRenderer.invoke("open-thread", id),
  renameThread: (id, title) => ipcRenderer.invoke("rename-thread", id, title),
  deleteThread: (id) => ipcRenderer.invoke("delete-thread", id),

  approvePairing: (sessionId) => ipcRenderer.invoke("approve-pairing", sessionId),
  rejectPairing: (sessionId) => ipcRenderer.invoke("reject-pairing", sessionId),
  selectSession: (sessionId) => ipcRenderer.invoke("select-session", sessionId),
  disconnectSession: (sessionId) => ipcRenderer.invoke("disconnect-session", sessionId),
  setPermission: (group, allowed) => ipcRenderer.invoke("set-permission", group, allowed),

  execute: (op, params) => ipcRenderer.invoke("execute", op, params),

  onServerEvent: (listener) => subscribe("server-event", listener),
  onAgentEvent: (listener) => subscribe("agent-event", listener),
  onThreadsChanged: (listener) => subscribe("threads", listener),
  onTranscript: (listener) => subscribe("transcript", listener),
});
