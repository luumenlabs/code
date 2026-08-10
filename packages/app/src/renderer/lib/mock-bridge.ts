/**
 * A fake bridge for working on the UI outside Electron.
 *
 * `pnpm --filter @luumen/code-app exec vite` serves the renderer in a browser,
 * where there is no preload and therefore no `window.luuCode`. Installing a
 * mock there means the interface can be designed and reviewed without Roblox
 * Studio, a coding agent, or a running server.
 *
 * Only ever installed in a dev build, and only when the real bridge is absent:
 * in a packaged app a missing bridge means preload failed, and quietly showing
 * invented data would hide that.
 */
import type { ActivityEvent, OutputEntry, ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, TranscriptEntry } from "../../shared/agent.js";
import type { HarnessSnapshot, LuuCodeBridge } from "../../shared/bridge.js";
import type { Thread, ThreadIndex } from "../../shared/threads.js";
import { CLAUDE_MODELS, CODEX_FALLBACK_MODELS, createSelection } from "../../shared/models.js";
import { DEFAULT_SETTINGS } from "../../shared/settings.js";
import type { AppSettings } from "../../shared/settings.js";

const SELECTION = createSelection("claude", "claude-opus-5");

const HOUR = 3_600_000;
const DAY = 86_400_000;

function placeholderScreenshot(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 420;

  const context = canvas.getContext("2d");

  if (context) {
    const sky = context.createLinearGradient(0, 0, 0, 420);
    sky.addColorStop(0, "#7dbbe6");
    sky.addColorStop(1, "#cfe8f5");
    context.fillStyle = sky;
    context.fillRect(0, 0, 720, 420);

    context.fillStyle = "#8fbf6b";
    context.fillRect(0, 300, 720, 120);

    context.fillStyle = "#d9d9d9";
    context.fillRect(250, 190, 220, 130);
    context.fillStyle = "#b9433b";
    context.beginPath();
    context.moveTo(232, 192);
    context.lineTo(360, 120);
    context.lineTo(488, 192);
    context.closePath();
    context.fill();

    context.fillStyle = "rgba(20,20,25,0.72)";
    context.fillRect(24, 24, 190, 62);
    context.fillStyle = "#ffffff";
    context.font = "600 15px Inter, sans-serif";
    context.fillText("Inventory", 40, 50);
    context.font = "13px Inter, sans-serif";
    context.fillText("3 items · 250 coins", 40, 72);
  }

  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

function activity(partial: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "op" | "title" | "category">): ActivityEvent {
  return {
    origin: "harness",
    detail: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "ok",
    error: null,
    instances: [],
    image: null,
    ...partial,
  } as ActivityEvent;
}

function entry(item: TranscriptEntry): TranscriptEntry {
  return item;
}

const now = Date.now();

const THREADS: ThreadIndex = {
  activeThreadId: "t_active",
  projects: [
    { id: "p_tycoon", placeId: 1234, name: "Tycoon Prototype", lastUsedAt: now },
    { id: "p_obby", placeId: 5678, name: "Sky Obby", lastUsedAt: now - 2 * DAY },
    { id: "p_rpg", placeId: 0, name: "Dungeon RPG (unsaved)", lastUsedAt: now - 9 * DAY },
  ],
  threads: [
    { id: "t_active", projectId: "p_tycoon", title: "Fix the inventory buy button", createdAt: now - HOUR, updatedAt: now - 4 * 60_000, agent: "claude", placeName: "Tycoon Prototype", messageCount: 3 },
    { id: "t2", projectId: "p_tycoon", title: "Add a dropper upgrade tier", createdAt: now - 6 * HOUR, updatedAt: now - 5 * HOUR, agent: "claude", placeName: "Tycoon Prototype", messageCount: 8 },
    { id: "t3", projectId: "p_tycoon", title: "Why does cash reset on rejoin?", createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY, agent: "codex", placeName: "Tycoon Prototype", messageCount: 12 },
    { id: "t4", projectId: "p_obby", title: "Make checkpoints save between sessions", createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY, agent: "claude", placeName: "Sky Obby", messageCount: 5 },
    { id: "t5", projectId: "p_obby", title: "Kill brick knockback feels wrong", createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, agent: "claude", placeName: "Sky Obby", messageCount: 4 },
    { id: "t6", projectId: "p_rpg", title: "Design the loot table module", createdAt: now - 9 * DAY, updatedAt: now - 9 * DAY, agent: "codex", placeName: "Dungeon RPG", messageCount: 21 },
  ],
};

const ITEMS: TranscriptEntry[] = [
  entry({ kind: "user", id: "u1", at: now - HOUR, text: "The buy button in the inventory always purchases the first item. Fix it and make sure it works." }),
  entry({ kind: "assistant", id: "m1", at: now - HOUR, text: "I'll look at how the inventory UI is wired up before changing anything." }),
  entry({ kind: "activity", id: "a1", at: now, activity: activity({ id: "a1", op: "dm.tree", title: "Reading the tree under StarterGui.Inventory", category: "inspect", detail: "34 instances" }) }),
  entry({ kind: "activity", id: "a2", at: now, activity: activity({ id: "a2", op: "script.get", title: "Reading StarterGui.Inventory.Controller", category: "inspect", detail: "128 lines" }) }),
  entry({ kind: "thinking", id: "t1", at: now, text: "The Buy button fires a RemoteEvent but never sends the selection, so the server always buys the first entry." }),
  entry({
    kind: "assistant",
    id: "m2",
    at: now,
    text: "Found it. The client sends the click but never the selection, so the server always buys the first item:\n\n```lua\nBuyButton.Activated:Connect(function()\n\tPurchase:FireServer()\nend)\n```\n\nI'll pass the selected item and validate it server-side.",
  }),
  entry({
    kind: "activity",
    id: "a3",
    at: now,
    activity: activity({
      id: "a3",
      op: "script.patch",
      title: "Editing StarterGui.Inventory.Controller",
      category: "edit",
      detail: "replaced 1 occurrence",
      instances: [{ handle: "@h12", path: "game.StarterGui.Inventory.Controller", name: "Controller", className: "LocalScript", childCount: 0 }],
    }),
  }),
  entry({
    kind: "activity",
    id: "a4",
    at: now,
    activity: activity({
      id: "a4",
      op: "script.patch",
      title: "Editing ServerScriptService.Shop.Handler",
      category: "edit",
      status: "error",
      error: {
        code: "NOT_ALLOWED_BY_ROBLOX",
        message: "Source is not writable on game.ServerScriptService.Shop.Handler: the script is locked by Studio",
        hint: "Unlock the script in Studio, then try again.",
      },
    }),
  }),
  entry({ kind: "activity", id: "a5", at: now, activity: activity({ id: "a5", op: "run.start", title: "Starting a playtest", category: "playtest", detail: "running in the client DataModel, ready" }) }),
  entry({ kind: "activity", id: "a6", at: now, activity: activity({ id: "a6", op: "input.gui_click", title: 'Clicking "Buy"', category: "input", detail: "clicked game.Players.Dev.PlayerGui.Inventory.Buy" }) }),
];

const SNAPSHOT: HarnessSnapshot = {
  status: {
    serverVersion: "0.1.0",
    activeSessionId: "s_demo",
    pending: [],
    sessions: [
      {
        id: "s_demo",
        installId: "demo",
        place: { placeId: 1234, gameId: 5678, name: "Tycoon Prototype", unsaved: false },
        studioVersion: "0.684.1",
        pluginVersion: "0.1.0",
        status: "connected",
        endpoints: [
          { id: "e_edit", realm: "edit", run: runState(false), lastSeen: now, polling: true },
          { id: "e_client", realm: "client", run: runState(true), lastSeen: now, polling: true },
        ],
        run: runState(true),
        lastSeen: now,
        active: true,
      },
    ],
  },
  capabilities: {
    platform: "win32",
    permissions: { inspect: true, edit: true, playtest: true, exec: true, input: true, screenshot: true },
    capabilities: [
      { id: "input.native", available: false, provider: "native", reason: "Desktop input is not implemented for this platform." },
    ],
  },
  agents: [
    { id: "claude", label: "Claude Code", command: "claude", version: "2.0.14", installed: true, problem: null, installHint: "" },
    {
      id: "codex",
      label: "Codex",
      command: null,
      version: null,
      installed: false,
      problem: "Codex was not found on this machine.",
      installHint: "Install the Codex CLI, then run `codex` once to sign in.",
    },
  ],
  models: [...CLAUDE_MODELS.map(({ minCliVersion: _drop, ...model }) => model), ...CODEX_FALLBACK_MODELS],
  modelProblem: null,
  settings: DEFAULT_SETTINGS,
  session: { agent: "claude", state: "working", sessionId: "demo", model: "claude-opus-5", message: null },
  serverPort: 33770,
  mcpCommand: "luu-code-mcp.cmd",
  platform: "win32",
  channel: "release",
  threads: THREADS,
  thread: {
    ...THREADS.threads[0]!,
    agentSessionId: "demo",
    modelSelection: SELECTION,
    items: ITEMS,
  } as Thread,
  modelSelection: SELECTION,
};

function runState(running: boolean): HarnessSnapshot["status"]["sessions"][number]["run"] {
  return {
    running,
    edit: !running,
    mode: running ? "play" : null,
    realm: running ? "client" : "edit",
    epoch: running ? 1 : 0,
    ready: running,
  };
}

function output(type: OutputEntry["type"], message: string, source: string | null, cursor: string): OutputEntry {
  return { cursor, timestamp: now, type, message, source, stack: null, realm: "client" };
}

export function installMockBridge(): void {
  const serverListeners = new Set<(event: ServerEvent) => void>();
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const transcriptListeners = new Set<(entry: TranscriptEntry) => void>();
  const threadListeners = new Set<(index: ThreadIndex) => void>();

  const emitServer = (event: ServerEvent): void => serverListeners.forEach((listener) => listener(event));
  const emitTranscript = (item: TranscriptEntry): void => transcriptListeners.forEach((listener) => listener(item));

  const bridge: LuuCodeBridge = {
    snapshot: async () => SNAPSHOT,
    refreshAgents: async () => SNAPSHOT.agents,
    sendMessage: async (text, attachments) => {
      emitTranscript({
        kind: "user",
        id: `u${Date.now()}`,
        at: Date.now(),
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      setTimeout(
        () => emitTranscript({ kind: "assistant", id: `m${Date.now()}`, at: Date.now(), text: `Sure — working on: ${text}` }),
        400,
      );
    },
    interruptAgent: async () => undefined,

    applyModel: async (selection) => selection,

    minimizeWindow: async () => undefined,
    toggleMaximizeWindow: async () => undefined,
    closeWindow: async () => undefined,
    isWindowMaximized: async () => false,
    onWindowStateChanged: () => () => undefined,

    newThread: async () => null,
    openThread: async (id) =>
      ({
        ...(THREADS.threads.find((thread) => thread.id === id) ?? THREADS.threads[0]!),
        agentSessionId: null,
        modelSelection: SELECTION,
        items: ITEMS,
      }) as Thread,
    renameThread: async () => THREADS,
    deleteThread: async () => THREADS,

    approvePairing: async () => true,
    rejectPairing: async () => true,
    selectSession: async () => undefined,
    disconnectSession: async () => undefined,
    setPermission: async () => undefined,
    execute: async () => ({}),

    updateSettings: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }) as AppSettings,
    resetSettings: async () => DEFAULT_SETTINGS,

    onServerEvent: (listener) => {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
    onAgentEvent: (listener) => {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    onTranscript: (listener) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    onThreadsChanged: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    onCatalogue: () => () => undefined,
    onSettingsChanged: () => () => undefined,
    onModelSelectionChanged: () => () => undefined,
  };

  window.luuCode = bridge;

  // A little live activity on top of the stored transcript, so streaming states
  // can be judged too.
  setTimeout(() => {
    emitServer({
      type: "output",
      sessionId: "s_demo",
      entries: [
        output("output", "Shop loaded with 12 items", null, "1"),
        output("warning", "Infinite yield possible on 'ReplicatedStorage:WaitForChild(\"Remotes\")'", null, "2"),
        output("error", "attempt to index nil with 'Price'", "Shop.Handler:42", "3"),
      ],
    });

    emitTranscript({
      kind: "activity",
      id: "a7",
      at: Date.now(),
      activity: activity({
        id: "a7",
        op: "view.screenshot",
        title: "Capturing a screenshot",
        category: "visual",
        detail: "720x420",
        image: { data: placeholderScreenshot(), mimeType: "image/png", width: 720, height: 420 },
      }),
    });

    emitTranscript({
      kind: "activity",
      id: "a8",
      at: Date.now(),
      activity: activity({ id: "a8", op: "dm.get", title: "Inspecting Players.Dev.Backpack", category: "inspect", status: "running", finishedAt: null }),
    });
  }, 80);
}
