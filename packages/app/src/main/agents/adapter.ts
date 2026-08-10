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
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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
  /**
   * Retargets a session that is already up.
   *
   * Changing the model used to mean restarting the CLI, which threw away the
   * conversation it was holding — so in practice the model was fixed the moment
   * you sent the first message. Both CLIs read the selection when they send, so
   * the change lands on the next message rather than on a new session.
   */
  setModelSelection(selection: import("../../shared/models.js").ModelSelection | null): void;
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

/**
 * Where a bare command name actually lives on Windows.
 *
 * npm installs a CLI as `name.cmd` plus `name.ps1`; there is no `name.exe` to
 * spawn. PATHEXT order decides which shim wins, and `.cmd` is the one Node can
 * drive without a PowerShell round trip.
 */
export function resolveWindowsExecutable(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }

  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Quotes one argument for a Windows command line.
 *
 * `cmd /s /c` strips the outermost pair of quotes and hands the rest to the
 * target, whose own parser follows the MSVC rules: a run of backslashes before
 * a quote is halved, and `\"` is a literal quote.
 */
function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"^&|<>()%!]/.test(value)) return value;

  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * How to launch a CLI without handing the arguments to a shell.
 *
 * `shell: true` on Windows is a trap: Node concatenates the arguments and lets
 * `cmd.exe` re-parse them, so quotes inside a value are eaten before the target
 * ever sees them — which silently corrupted the TOML overrides Codex is given —
 * and any argument built from user text becomes a command-injection vector.
 */
function resolveLaunch(command: string, args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
  verbatim: boolean;
} {
  if (process.platform !== "win32") return { command, args, shell: false, verbatim: false };

  const resolved = resolveWindowsExecutable(command);

  // Nothing found: fall back to letting the shell search, which is still better
  // than failing outright.
  if (!resolved) return { command, args, shell: true, verbatim: false };

  const isScript = /\.(cmd|bat)$/i.test(resolved);
  if (!isScript) return { command: resolved, args, shell: false, verbatim: false };

  const line = [resolved, ...args].map(quoteWindowsArg).join(" ");
  return {
    command: process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    shell: false,
    verbatim: true,
  };
}

/**
 * The environment an agent CLI should inherit.
 *
 * Everything the user has, so the CLI finds its own credentials exactly as it
 * would in a terminal — minus one variable. Electron-based tools launched from
 * an Electron-hosted terminal inherit ELECTRON_RUN_AS_NODE and silently start
 * as plain Node instead of as themselves. Agent CLIs are often Electron apps,
 * so it is stripped rather than passed on.
 */
export function agentEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function spawnAgent(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const env = agentEnvironment();
  const launch = resolveLaunch(command, args);

  return spawn(launch.command, launch.args, {
    cwd,
    env,
    windowsHide: true,
    shell: launch.shell,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
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
