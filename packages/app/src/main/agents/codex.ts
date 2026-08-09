/**
 * Codex adapter.
 *
 * Codex runs a turn per invocation rather than holding a session open, so each
 * message spawns `codex exec` and follow-ups resume the previous conversation.
 * The MCP server is passed as a config override so the user's own
 * ~/.codex/config.toml is left alone.
 *
 * Codex's JSON event shape has changed across releases. The parser below
 * accepts the shapes seen so far and falls back to showing raw text rather than
 * dropping output, which keeps the harness usable when the CLI moves ahead of
 * this adapter.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLineReader, describeExit, nextId, spawnAgent } from "./adapter.js";
import type { AgentAdapter, StartOptions } from "./adapter.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;

  private options: StartOptions | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private hasConversation = false;
  private stderr = "";

  get running(): boolean {
    return this.started;
  }

  private resumeId: string | null = null;

  async start(options: StartOptions): Promise<void> {
    this.options = options;
    this.started = true;
    this.resumeId = options.resumeSessionId ?? null;
    // With a stored session id the next turn resumes that conversation instead
    // of starting a new one.
    this.hasConversation = this.resumeId !== null;
    options.onEvent({ type: "state", state: "idle" });
  }

  async send(text: string): Promise<void> {
    const options = this.options;
    if (!options) throw new Error("Codex is not running.");
    if (this.child) throw new Error("Codex is still working on the previous message.");

    // Config overrides rather than a config file, so the user's own
    // ~/.codex/config.toml is never rewritten by Luu Code.
    const selection = options.modelSelection;
    const effort = selection?.options.find((entry) => entry.id === "reasoningEffort")?.value;

    const overrides = [
      "-c",
      `mcp_servers.luu-code.command=${JSON.stringify(options.mcp.command)}`,
      "-c",
      `mcp_servers.luu-code.args=${JSON.stringify(options.mcp.args)}`,
      "-c",
      `mcp_servers.luu-code.env=${JSON.stringify(options.mcp.env)}`,
      ...(selection ? ["-c", `model=${JSON.stringify(selection.model)}`] : []),
      ...(typeof effort === "string" ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    ];

    // Resuming by id targets the exact conversation the thread belongs to;
    // --last would pick up whatever Codex ran most recently, which may be a
    // different thread entirely.
    const resumeTarget = this.resumeId ? [this.resumeId] : ["--last"];

    const args = this.hasConversation
      ? ["exec", "resume", ...resumeTarget, "--json", "--skip-git-repo-check", ...overrides, text]
      : ["exec", "--json", "--skip-git-repo-check", ...overrides, text];

    this.stderr = "";
    options.onEvent({ type: "state", state: "thinking" });

    const child = spawnAgent(options.command, args, options.cwd);
    this.child = child;

    const reader = new JsonLineReader((value, raw) => this.handle(value, raw));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
    });

    child.on("error", (error) => {
      options.onEvent({ type: "error", message: `Could not start Codex: ${error.message}` });
      options.onEvent({ type: "state", state: "error" });
      this.child = null;
    });

    child.on("exit", (code) => {
      reader.flush();
      this.child = null;

      if (code !== 0) {
        options.onEvent({ type: "error", message: describeExit("codex", code, this.stderr) });
        options.onEvent({ type: "state", state: "error" });
        return;
      }

      this.hasConversation = true;
      options.onEvent({ type: "turn-complete", summary: null });
      options.onEvent({ type: "state", state: "idle" });
    });
  }

  interrupt(): void {
    this.child?.kill("SIGINT");
    this.child = null;
    this.options?.onEvent({ type: "state", state: "idle", message: "Interrupted." });
  }

  async stop(): Promise<void> {
    this.started = false;
    const child = this.child;
    this.child = null;
    child?.kill("SIGTERM");
  }

  private handle(value: unknown, raw: string): void {
    const emit = this.options?.onEvent;
    if (!emit) return;

    if (value === undefined || typeof value !== "object" || value === null) {
      if (raw.trim().length > 0) emit({ type: "assistant", id: nextId("m"), text: raw.trim() });
      return;
    }

    const event = value as Record<string, any>;

    // Newer releases wrap events as {type:"item.completed", item:{...}}.
    const item = event.item ?? event.msg ?? event;
    const kind = String(item.type ?? event.type ?? "");

    if (kind === "session.created" || kind === "session_configured") {
      const sessionId = String(item.session_id ?? item.sessionId ?? "");
      if (sessionId) this.resumeId = sessionId;
      emit({ type: "session", sessionId, model: item.model ?? null });
      return;
    }

    if (kind === "agent_message" || kind === "assistant_message") {
      const text = item.text ?? item.message ?? "";
      if (text) emit({ type: "assistant", id: nextId("m"), text: String(text) });
      return;
    }

    if (kind === "reasoning" || kind === "agent_reasoning") {
      const text = item.text ?? item.summary ?? "";
      if (text) emit({ type: "thinking", id: nextId("t"), text: String(text) });
      return;
    }

    if (kind === "command_execution" || kind === "exec_command_begin" || kind === "local_shell_call") {
      emit({
        type: "tool-use",
        id: String(item.id ?? item.call_id ?? nextId("tool")),
        name: "shell",
        input: item.command ?? item.parsed_cmd ?? {},
      });
      return;
    }

    if (kind === "mcp_tool_call" || kind === "mcp_tool_call_begin") {
      emit({
        type: "tool-use",
        id: String(item.id ?? item.call_id ?? nextId("tool")),
        name: String(item.tool ?? item.tool_name ?? "mcp"),
        input: item.arguments ?? item.input ?? {},
      });
      return;
    }

    if (kind === "mcp_tool_call_end" || kind === "exec_command_end" || kind === "command_execution_output") {
      emit({
        type: "tool-result",
        id: String(item.id ?? item.call_id ?? ""),
        isError: item.success === false || item.exit_code === 1,
        text: String(item.output ?? item.result ?? item.stdout ?? ""),
      });
      return;
    }

    if (kind === "error" || kind === "stream_error") {
      emit({ type: "error", message: String(item.message ?? item.error ?? "Codex reported an error") });
    }
  }
}
