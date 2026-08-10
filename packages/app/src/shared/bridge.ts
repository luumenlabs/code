/**
 * The contract between the renderer and the main process.
 *
 * Kept narrow on purpose: the renderer can drive Roblox operations, the agent
 * session, and its own conversation history, and nothing else. Spec section 39
 * rules out turning this into a general local tooling surface.
 */
import type { CapabilityReport, PermissionGroup, ServerEvent, SessionStatus } from "@luumen/code-protocol";
import type {
  AgentEvent,
  AgentInfo,
  AgentSessionSnapshot,
  AgentState,
  Attachment,
  TranscriptEntry,
} from "./agent.js";
import type { AppSettings } from "./settings.js";
import type { Thread, ThreadIndex } from "./threads.js";
import type { VersionStatus } from "./update.js";

export interface HarnessSnapshot {
  status: SessionStatus;
  capabilities: CapabilityReport;
  agents: AgentInfo[];
  /** What the installed CLIs currently offer, not a list baked into the build. */
  models: import("./models.js").ModelInfo[];
  /** Why the Codex list is the built-in fallback, when it is. */
  modelProblem: string | null;
  settings: AppSettings;
  /** The open conversation's session. Chats each have their own. */
  session: AgentSessionSnapshot;
  /**
   * Every conversation's agent state, keyed by thread id.
   *
   * Conversations run in parallel, so "is something working" is a question per
   * chat rather than per app — the sidebar needs all of them to know which rows
   * to spin.
   */
  agentStates: Record<string, AgentState>;
  serverPort: number;
  /** The command that runs this build's own MCP server. */
  mcpCommand: string;
  /** App update, Studio plugin, and the MCP command they all share. */
  versions: VersionStatus;
  /** Drives platform-specific chrome, such as room for window controls. */
  platform: string;
  /** Release, nightly, or a build run from source. */
  channel: import("./update.js").Channel;
  threads: ThreadIndex;
  /** The conversation currently open, or null while a draft is being composed. */
  thread: Thread | null;
  /** The open thread's model, or the draft's. */
  modelSelection: import("./models.js").ModelSelection | null;
}

export interface LuuCodeBridge {
  snapshot(): Promise<HarnessSnapshot>;
  refreshAgents(): Promise<AgentInfo[]>;

  /**
   * Sends a message, starting the CLI behind the chosen model if it is not
   * already running. There is no separate "start the agent" step: the user
   * picks a model, and the CLI that serves it follows.
   */
  sendMessage(text: string, attachments?: Attachment[]): Promise<void>;
  /** Stops the turn in the open conversation. Others keep working. */
  interruptAgent(): Promise<void>;

  /**
   * Applies a model together with its options, and with it the CLI that serves
   * it. One call, because they are one choice.
   */
  applyModel(selection: import("./models.js").ModelSelection): Promise<import("./models.js").ModelSelection>;

  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowStateChanged(listener: (maximized: boolean) => void): () => void;

  // Conversation history. Spec section 45.
  /** Starts a draft. Returns null: nothing is stored until the first message. */
  newThread(): Promise<null>;
  openThread(id: string): Promise<Thread | null>;
  renameThread(id: string, title: string): Promise<ThreadIndex>;
  /** Files a conversation away, or brings it back. */
  archiveThread(id: string, archived: boolean): Promise<ThreadIndex>;
  deleteThread(id: string): Promise<ThreadIndex>;

  approvePairing(sessionId: string): Promise<boolean>;
  rejectPairing(sessionId: string): Promise<boolean>;
  selectSession(sessionId: string): Promise<void>;
  disconnectSession(sessionId: string): Promise<void>;
  setPermission(group: PermissionGroup, allowed: boolean): Promise<void>;

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetSettings(): Promise<AppSettings>;

  // Versions. The app, the Studio plugin, and the MCP server move together.
  versionStatus(): Promise<VersionStatus>;
  checkForUpdate(): Promise<VersionStatus>;
  downloadUpdate(): Promise<VersionStatus>;
  /** Quits and installs. The app does not come back until the installer is done. */
  installUpdate(): Promise<VersionStatus>;
  /** Writes the plugin this build carries into the Studio plugins folder. */
  installPlugin(): Promise<VersionStatus>;
  uninstallPlugin(): Promise<VersionStatus>;
  openReleases(): Promise<void>;
  revealPluginFolder(): Promise<void>;

  /** Runs a Roblox operation from the UI, for the manual controls. */
  execute(op: string, params?: unknown): Promise<unknown>;

  onServerEvent(listener: (event: ServerEvent) => void): () => void;
  /** Carries the thread the event came from: several may be running. */
  onAgentEvent(listener: (payload: { threadId: string; event: AgentEvent }) => void): () => void;
  /** Fires whenever any conversation starts or stops working. */
  onAgentStates(listener: (states: Record<string, AgentState>) => void): () => void;
  /** Fires when the thread list changes, so the sidebar stays current. */
  onThreadsChanged(listener: (index: ThreadIndex) => void): () => void;
  /** Fires when CLI discovery finishes, which happens after the window opens. */
  onCatalogue(
    listener: (payload: { models: import("./models.js").ModelInfo[]; problem: string | null }) => void,
  ): () => void;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  /** Fires as a check runs, a download progresses, or the plugin is written. */
  onVersionStatus(listener: (status: VersionStatus) => void): () => void;
  onModelSelectionChanged(listener: (selection: import("./models.js").ModelSelection) => void): () => void;
  /**
   * The main process persists the transcript; this echoes what it stored, with
   * the conversation it was stored against. Entries for a chat that is not open
   * are already on disk and arrive with it when it is.
   */
  onTranscript(listener: (payload: { threadId: string; entry: TranscriptEntry }) => void): () => void;
}

declare global {
  interface Window {
    luuCode: LuuCodeBridge;
  }
}
