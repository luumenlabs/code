/**
 * Owns the active coding-agent session.
 *
 * The harness starts the agent the user picked, points it at the Luu Code MCP
 * server, and relays its output. Which agent is running never changes anything
 * on the Roblox side. Spec section 6.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentId, AgentInfo, AgentSessionSnapshot } from "../../shared/agent.js";
import type { AgentAdapter, McpServerSpec } from "./adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { discoverAgents } from "./discovery.js";


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
  onEvent: (event: AgentEvent) => void;
}

export class AgentManager {
  private adapter: AgentAdapter | null = null;
  private agents: AgentInfo[] = [];
  private snapshot: AgentSessionSnapshot = { agent: null, state: "stopped", sessionId: null, model: null, message: null };
  private workingDirectory: string = process.cwd();
  private permissionMode = "acceptEdits";
  private modelSelection: import("../../shared/models.js").ModelSelection | null = null;

  setModelSelection(selection: import("../../shared/models.js").ModelSelection | null): void {
    this.modelSelection = selection;
  }

  constructor(private readonly options: AgentManagerOptions) {}

  async list(refresh = false): Promise<AgentInfo[]> {
    if (refresh || this.agents.length === 0) {
      this.agents = await discoverAgents();
    }
    return this.agents;
  }

  status(): AgentSessionSnapshot {
    return this.snapshot;
  }

  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
  }

  async start(id: AgentId, resumeSessionId?: string | null): Promise<AgentSessionSnapshot> {
    await this.stop();

    const info = (await this.list()).find((entry) => entry.id === id);

    if (!info?.installed || !info.command) {
      this.snapshot = {
        agent: id,
        state: "error",
        sessionId: null,
        model: null,
        message: info?.problem ? `${info.problem} ${info.installHint}` : `${id} is not available.`,
      };
      return this.snapshot;
    }

    const adapter: AgentAdapter = id === "claude" ? new ClaudeAdapter() : new CodexAdapter();
    this.adapter = adapter;

    const mcp = this.mcpServerSpec();
    const mcpConfigPath = this.writeMcpConfig(mcp);

    this.snapshot = { agent: id, state: "starting", sessionId: null, model: null, message: null };

    await adapter.start({
      command: info.command,
      cwd: this.workingDirectory,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}),
      mcp,
      mcpConfigPath,
      permissionMode: this.permissionMode,
      onEvent: (event) => this.handle(event),
    });

    return this.snapshot;
  }

  async send(text: string): Promise<void> {
    if (!this.adapter) throw new Error("No coding agent is running. Choose one first.");
    await this.adapter.send(text);
  }

  interrupt(): void {
    this.adapter?.interrupt();
  }

  async stop(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    await adapter?.stop();
    this.snapshot = { ...this.snapshot, state: "stopped" };
  }

  private handle(event: AgentEvent): void {
    if (event.type === "state") {
      this.snapshot = { ...this.snapshot, state: event.state, message: event.message ?? null };
    } else if (event.type === "session") {
      this.snapshot = { ...this.snapshot, sessionId: event.sessionId, model: event.model };
    }

    this.options.onEvent(event);
  }

  /**
   * Runs the MCP server with Electron's bundled Node, so a packaged app does
   * not depend on the user having Node or the CLI installed globally.
   */
  private mcpServerSpec(): McpServerSpec {
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
    if (this.options.luuCodeHome) env.LUU_CODE_HOME = this.options.luuCodeHome;

    return { command: process.execPath, args: [this.options.mcpScriptPath], env };
  }

  private writeMcpConfig(mcp: McpServerSpec): string {
    mkdirSync(this.options.stateDir, { recursive: true });
    const path = join(this.options.stateDir, "mcp.json");

    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { "luu-code": { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2)}\n`,
    );

    return path;
  }
}
