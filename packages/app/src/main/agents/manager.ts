/**
 * Owns the coding-agent sessions — one per conversation, all running at once.
 *
 * There used to be exactly one. Opening another chat stopped it, which was
 * wrong twice over: the work you had started was thrown away, and the app said
 * "stopped" while the CLI was still draining its stream, so late events landed
 * in whichever conversation you had just switched to. A chat is a session; the
 * one you are looking at is a view, not a lifecycle.
 *
 * Every event carries the key of the session that produced it, so nothing
 * downstream has to guess which conversation it belongs to. Spec section 6.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentId, AgentInfo, AgentSessionSnapshot, AgentState, Attachment } from "../../shared/agent.js";
import { setModelCatalogue } from "../../shared/models.js";
import type { ModelInfo, ModelSelection } from "../../shared/models.js";
import type { AgentAdapter, McpServerSpec } from "./adapter.js";
import { discoverModels } from "./catalog.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { discoverAgents } from "./discovery.js";
import { withUpdateAdvisory } from "./updates.js";

export interface AgentManagerOptions {
  /** Where the MCP config file is written. */
  stateDir: string;
  /** Passed to the MCP child so it attaches to this app's server. */
  luuCodeHome: string | undefined;
  /**
   * Absolute path to the MCP stdio entry point.
   *
   * Resolved by the caller rather than with `createRequire` here: the main
   * process is bundled, and Electron loads that bundle through the ESM→CJS
   * translator, where `__filename` is not defined.
   */
  mcpScriptPath: string;
  /** `key` is the thread the event belongs to, never the one on screen. */
  onEvent: (key: string, event: AgentEvent) => void;
  /** Fires whenever any session changes state, for the sidebar's spinners. */
  onStates: (states: Record<string, AgentState>) => void;
}

/** How a session is started. The caller owns the thread, so it owns these. */
export interface SessionOptions {
  agent: AgentId;
  cwd: string;
  modelSelection: ModelSelection | null;
  /** The CLI's own id from a previous run, when it can genuinely be resumed. */
  resumeSessionId?: string | null;
}

interface Session {
  adapter: AgentAdapter | null;
  snapshot: AgentSessionSnapshot;
  cwd: string;
  modelSelection: ModelSelection | null;
}

const STOPPED: AgentSessionSnapshot = { agent: null, state: "stopped", sessionId: null, model: null, message: null };

/** The states that mean a turn is in flight. */
export function isBusy(state: AgentState | undefined): boolean {
  return state === "starting" || state === "thinking" || state === "working";
}

export class AgentManager {
  private readonly sessions = new Map<string, Session>();
  private agents: AgentInfo[] = [];
  private catalogue: ModelInfo[] = [];
  private problem: string | null = null;
  private discovery: Promise<AgentInfo[]> | null = null;
  private permissionMode = "acceptEdits";
  /** Written once: every session is handed the same server. */
  private mcpConfigPath: string | null = null;

  constructor(private readonly options: AgentManagerOptions) {}

  async list(refresh = false): Promise<AgentInfo[]> {
    if (!refresh && this.agents.length > 0) return this.agents;

    // Startup and the renderer's first snapshot both want this, and discovery
    // spawns a real `codex app-server`. Share one run rather than two.
    this.discovery ??= this.discover(refresh).finally(() => {
      this.discovery = null;
    });

    return this.discovery;
  }

  private async discover(refresh: boolean): Promise<AgentInfo[]> {
    // The advisory is a network call and never blocks the answer: it resolves
    // to nulls rather than failing, so a machine with no internet discovers its
    // CLIs exactly as before.
    this.agents = await withUpdateAdvisory(await discoverAgents(), refresh);
    await this.refreshModels();
    return this.agents;
  }

  /** What the installed CLIs currently offer. Empty until the first `list()`. */
  models(): ModelInfo[] {
    return this.catalogue;
  }

  /** Why the Codex list is the built-in fallback rather than the live one. */
  catalogueProblem(): string | null {
    return this.problem;
  }

  private async refreshModels(): Promise<void> {
    const result = await discoverModels(this.agents);
    this.catalogue = result.models;
    this.problem = result.problem;
    // Adapters and the thread store resolve slugs through the shared
    // catalogue, so the discovered list has to become the one they see.
    setModelCatalogue(result.models);
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
  }

  /** One conversation's session, or a stopped one for a chat never started. */
  status(key: string | null): AgentSessionSnapshot {
    if (!key) return STOPPED;
    return this.sessions.get(key)?.snapshot ?? STOPPED;
  }

  /** Every session's state, keyed by thread. What the sidebar renders from. */
  states(): Record<string, AgentState> {
    const out: Record<string, AgentState> = {};
    for (const [key, session] of this.sessions) out[key] = session.snapshot.state;
    return out;
  }

  running(key: string | null): boolean {
    return isBusy(this.status(key).state);
  }

  /** True while any conversation still has a turn in flight. */
  anyRunning(): boolean {
    return [...this.sessions.values()].some((session) => isBusy(session.snapshot.state));
  }

  /**
   * The model a running session is on.
   *
   * Changing it mid-conversation is applied to the live adapter, so a message
   * sent after the change uses the model that was picked, not the one the
   * session happened to start on.
   */
  setModelSelection(key: string, selection: ModelSelection | null): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.modelSelection = selection;
    session.adapter?.setModelSelection(selection);
  }

  /**
   * Brings up the session for a conversation, reusing the one already there.
   *
   * The user picks a model, not a CLI, so the CLI comes up on its own. A live
   * session on the same CLI is kept: restarting it would throw away the
   * conversation it is holding.
   */
  async ensure(key: string, options: SessionOptions): Promise<AgentSessionSnapshot> {
    const existing = this.sessions.get(key);

    if (existing?.adapter?.id === options.agent && existing.adapter.running) {
      existing.cwd = options.cwd;
      this.setModelSelection(key, options.modelSelection);
      return existing.snapshot;
    }

    return this.start(key, options);
  }

  private async start(key: string, options: SessionOptions): Promise<AgentSessionSnapshot> {
    await this.stop(key);

    const info = (await this.list()).find((entry) => entry.id === options.agent);

    if (!info?.installed || !info.command) {
      return this.setSnapshot(key, {
        agent: options.agent,
        state: "error",
        sessionId: null,
        model: null,
        message: info?.problem
          ? `${info.problem} ${info.installHint}`
          : `${options.agent} is not available.`,
      });
    }

    const adapter: AgentAdapter = options.agent === "claude" ? new ClaudeAdapter() : new CodexAdapter();

    this.sessions.set(key, {
      adapter,
      snapshot: { agent: options.agent, state: "starting", sessionId: null, model: null, message: null },
      cwd: options.cwd,
      modelSelection: options.modelSelection,
    });
    this.announce();

    const mcp = this.mcpServerSpec(key);

    await adapter.start({
      command: info.command,
      cwd: options.cwd,
      ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
      mcp,
      mcpConfigPath: this.writeMcpConfig(mcp),
      permissionMode: this.permissionMode,
      // Bound to the key rather than to "the current chat": by the time this
      // fires the user may be looking at something else entirely.
      onEvent: (event) => this.handle(key, event),
    });

    return this.status(key);
  }

  async send(key: string, text: string, attachments?: Attachment[]): Promise<void> {
    const adapter = this.sessions.get(key)?.adapter;
    if (!adapter) throw new Error("No coding agent is running for this chat. Choose a model first.");
    await adapter.send(text, attachments);
  }

  interrupt(key: string | null): void {
    if (!key) return;
    this.sessions.get(key)?.adapter?.interrupt();
  }

  /** Ends one conversation's session. Everything else keeps running. */
  async stop(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;

    const adapter = session.adapter;
    session.adapter = null;
    await adapter?.stop();

    // The session record is kept so the state is still reportable; only the
    // process behind it is gone.
    session.snapshot = { ...session.snapshot, state: "stopped" };
    this.announce();
  }

  /** Forgets a conversation entirely, for a chat that has been deleted. */
  async discard(key: string): Promise<void> {
    await this.stop(key);
    this.sessions.delete(key);
    this.announce();
  }

  /** On quit. Every CLI the app started is the app's to shut down. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.stop(key)));
  }

  private setSnapshot(key: string, snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
    const session = this.sessions.get(key);

    if (session) session.snapshot = snapshot;
    else this.sessions.set(key, { adapter: null, snapshot, cwd: process.cwd(), modelSelection: null });

    this.announce();
    return snapshot;
  }

  private handle(key: string, event: AgentEvent): void {
    const session = this.sessions.get(key);

    if (session) {
      if (event.type === "state") {
        session.snapshot = { ...session.snapshot, state: event.state, message: event.message ?? null };
        this.announce();
      } else if (event.type === "session") {
        session.snapshot = { ...session.snapshot, sessionId: event.sessionId, model: event.model };
      }
    }

    this.options.onEvent(key, event);
  }

  private announce(): void {
    this.options.onStates(this.states());
  }

  /**
   * Runs the MCP server with Electron's bundled Node, so a packaged app does
   * not depend on the user having Node or the CLI installed globally.
   *
   * `key` rides along in the environment so every Roblox operation this session
   * performs comes back labelled with the conversation that asked for it. Each
   * chat has its own agent and they all share one server, so without the label
   * their work is indistinguishable at the far end.
   */
  private mcpServerSpec(key?: string): McpServerSpec {
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
    if (this.options.luuCodeHome) env.LUU_CODE_HOME = this.options.luuCodeHome;
    if (key) env.LUU_CODE_CHAT = key;

    return { command: process.execPath, args: [this.options.mcpScriptPath], env };
  }

  /**
   * Written once, not per session: every session points at the same server, so
   * concurrent starts would otherwise race to rewrite the same file with the
   * same bytes.
   */
  private writeMcpConfig(mcp: McpServerSpec): string {
    if (this.mcpConfigPath) return this.mcpConfigPath;

    mkdirSync(this.options.stateDir, { recursive: true });
    const path = join(this.options.stateDir, "mcp.json");

    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { "luu-code": { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2)}\n`,
    );

    this.mcpConfigPath = path;
    return path;
  }
}
