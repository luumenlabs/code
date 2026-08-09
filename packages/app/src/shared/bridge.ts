/**
 * The contract between the renderer and the main process.
 *
 * Kept narrow on purpose: the renderer can drive Roblox operations, the agent
 * session, and its own conversation history, and nothing else. Spec section 39
 * rules out turning this into a general local tooling surface.
 */
import type { CapabilityReport, PermissionGroup, ServerEvent, SessionStatus } from "@luumen/code-protocol";
import type { AgentEvent, AgentInfo, AgentSessionSnapshot, Attachment, TranscriptEntry } from "./agent.js";
import type { Thread, ThreadIndex } from "./threads.js";

export interface HarnessSnapshot {
  status: SessionStatus;
  capabilities: CapabilityReport;
  agents: AgentInfo[];
  session: AgentSessionSnapshot;
  serverPort: number;
  mcpCommand: string;
  /** Drives platform-specific chrome, such as room for window controls. */
  platform: string;
  threads: ThreadIndex;
  /** The conversation currently open, including its transcript. */
  thread: Thread | null;
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
  interruptAgent(): Promise<void>;

  setModel(selection: import("./models.js").ModelSelection): Promise<import("./models.js").ModelSelection | null>;
  /** Picks a model and, with it, the CLI that serves it. */
  chooseModel(slug: string): Promise<import("./models.js").ModelSelection>;

  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowStateChanged(listener: (maximized: boolean) => void): () => void;

  // Conversation history. Spec section 45.
  newThread(): Promise<Thread>;
  openThread(id: string): Promise<Thread | null>;
  renameThread(id: string, title: string): Promise<ThreadIndex>;
  deleteThread(id: string): Promise<ThreadIndex>;

  approvePairing(sessionId: string): Promise<boolean>;
  rejectPairing(sessionId: string): Promise<boolean>;
  selectSession(sessionId: string): Promise<void>;
  disconnectSession(sessionId: string): Promise<void>;
  setPermission(group: PermissionGroup, allowed: boolean): Promise<void>;

  /** Runs a Roblox operation from the UI, for the manual controls. */
  execute(op: string, params?: unknown): Promise<unknown>;

  onServerEvent(listener: (event: ServerEvent) => void): () => void;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /** Fires when the thread list changes, so the sidebar stays current. */
  onThreadsChanged(listener: (index: ThreadIndex) => void): () => void;
  /** The main process persists the transcript; this echoes what it stored. */
  onTranscript(listener: (entry: TranscriptEntry) => void): () => void;
}

declare global {
  interface Window {
    luuCode: LuuCodeBridge;
  }
}
