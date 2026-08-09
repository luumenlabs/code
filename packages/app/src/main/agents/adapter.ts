/**
 * Shared plumbing for coding-agent adapters.
 *
 * Agents are external processes the user already owns. Luu Code starts them,
 * points them at its MCP server, and translates their output. It does not proxy
 * a model, hold an API key, or reason on the agent's behalf. Spec sections 3.2
 * and 38.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, AgentId, Attachment } from "../../shared/agent.js";

/** How to launch the Luu Code MCP server, in the form each CLI wants it. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface StartOptions {
  command: string;
  cwd: string;
  /**
   * The CLI's own session id from a previous run. Present means the user
   * reopened a thread and the conversation should continue where it left off.
   * Spec section 45: continuity is never faked, so this is only set when the
   * agent actually gave us an id.
   */
  resumeSessionId?: string;
  mcp: McpServerSpec;
  /** The same spec written to disk, for CLIs that take a config file. */
  mcpConfigPath: string;
  /** Model and its per-model options, chosen in the composer. */
  modelSelection?: import("../../shared/models.js").ModelSelection;
  /** Passed through to the agent CLI; the user controls it in the UI. */
  permissionMode: string;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentAdapter {
  readonly id: AgentId;
  start(options: StartOptions): Promise<void>;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  interrupt(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

/** File extension for an attachment, so a written temp file is recognisable. */
export function extensionFor(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? "png";
  return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "") || "png";
}

/** Splits a stream into lines and hands each parsed JSON object to the sink. */
export class JsonLineReader {
  private buffer = "";

  constructor(private readonly onValue: (value: unknown, raw: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");

      if (line.length === 0) continue;

      try {
        this.onValue(JSON.parse(line), line);
      } catch {
        // Agents occasionally print human-readable lines alongside JSON.
        this.onValue(undefined, line);
      }
    }
  }

  flush(): void {
    const line = this.buffer.trim();
    this.buffer = "";
    if (line.length === 0) return;

    try {
      this.onValue(JSON.parse(line), line);
    } catch {
      this.onValue(undefined, line);
    }
  }
}

export function spawnAgent(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  // Inherit the environment so the CLI finds its own credentials, exactly as it
  // would in a terminal.
  const env = { ...process.env };

  // Electron-based tools launched from an Electron-hosted terminal inherit this
  // and silently start as plain Node instead of as themselves. Agent CLIs are
  // often Electron apps, so it is stripped rather than passed on.
  delete env.ELECTRON_RUN_AS_NODE;

  return spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/**
 * Common exit handling: a non-zero exit that produced no output almost always
 * means the CLI is not authenticated, which is worth saying outright.
 */
export function describeExit(id: AgentId, code: number | null, stderr: string): string {
  const trimmed = stderr.trim();

  if (trimmed.length > 0) return trimmed;
  if (code === 0) return `${id} exited.`;

  return `${id} exited with code ${code ?? "unknown"}. Run it once in a terminal to check that it is signed in.`;
}
