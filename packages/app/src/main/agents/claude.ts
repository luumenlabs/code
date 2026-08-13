/**
 * Claude Code adapter, on the Claude Agent SDK.
 *
 * The earlier version shelled out to `claude --print --output-format
 * stream-json` and did not work. The SDK is the supported way to drive Claude
 * Code programmatically: it owns the session lifecycle, streams typed messages,
 * and takes the model, reasoning effort, and MCP servers as options rather than
 * as flags whose behaviour shifts between releases.
 *
 * Authentication is still the user's own — the SDK runs the `claude` binary
 * they already installed and signed in.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as ClaudeQueryOptions, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { effectiveOption, findModel } from "../../shared/models.js";
import type { Attachment } from "../../shared/agent.js";
import type { ModelSelection } from "../../shared/models.js";
import { agentEnvironment, nextId } from "./adapter.js";
import { resolveClaudeExecutable } from "./claudeExecutable.js";
import { briefingFor } from "./briefing.js";
import type { AgentAdapter, StartOptions } from "./adapter.js";

type SdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

/**
 * `ultrathink` is a prompt-level instruction, not an API effort, and
 * `ultracode` is a Claude Code setting normalised onto `xhigh`. Everything else
 * maps straight through.
 */
function sdkEffort(effort: string | undefined): SdkEffort | undefined {
  if (!effort || effort === "ultrathink") return undefined;
  if (effort === "ultracode") return "xhigh" as SdkEffort;
  return effort as SdkEffort;
}

/** Claude Code selects the 1M variant through the slug: `claude-opus-5[1m]`. */
function apiModelId(selection: ModelSelection | undefined): string | undefined {
  if (!selection) return undefined;

  const info = findModel(selection.model);
  if (!info) return selection.model;

  const context = info.options.find((option) => option.id === "contextWindow");
  if (!context) return selection.model;

  return effectiveOption(selection, context) === "1m" ? `${selection.model}[1m]` : selection.model;
}

/**
 * The built-in tools that have nothing to work on here.
 *
 * Removed from the model's context rather than refused when called: the
 * working directory is an empty scratch folder, so these can only waste a turn
 * and then mislead — a failed `Read` reads as "the workspace is broken" rather
 * than "the game is not on disk".
 *
 * Named subtractively on purpose. An earlier version allow-listed the Roblox
 * tools by name and denied everything else, so the moment a tool name arrived
 * in a shape the pattern did not expect, every Roblox tool was refused at once.
 * Listing what to remove inverts the worst case: an unrecognised name survives.
 */
const NO_FILESYSTEM_HERE = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
];


export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;

  private options: StartOptions | null = null;
  private queue: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private abort: AbortController | null = null;
  private sessionId: string | null = null;
  private active = false;

  get running(): boolean {
    return this.active;
  }

  async start(options: StartOptions): Promise<void> {
    this.options = options;
    this.active = true;
    this.sessionId = options.resumeSessionId ?? null;
    options.onEvent({ type: "state", state: "idle" });
  }

  setModelSelection(selection: ModelSelection | null): void {
    if (!this.options) return;
    // Read again on every send, so the next message uses it. A run already
    // streaming keeps the model it started on — the API call is made.
    this.options = { ...this.options, ...(selection ? { modelSelection: selection } : { modelSelection: undefined }) };
  }

  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    const options = this.options;
    if (!options) throw new Error("Claude Code is not running.");

    const selection = options.modelSelection;
    const effort = selection?.options.find((entry) => entry.id === "effort")?.value as string | undefined;

    // Ultrathink is asked for in the prompt itself, not sent as an API effort.
    const prompt = effort === "ultrathink" ? `ultrathink\n\n${text}` : text;

    this.queue.push(userMessage(prompt, attachments));
    this.notify?.();

    // A run is already streaming; the queued message joins it.
    if (this.abort) return;

    await this.run(options, selection, effort);
  }

  private async run(options: StartOptions, selection: ModelSelection | undefined, effort: string | undefined): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;

    options.onEvent({ type: "state", state: "thinking" });

    const model = apiModelId(selection);
    const fastMode = selection?.options.find((entry) => entry.id === "fastMode")?.value === true;
    const settings = {
      ...(fastMode ? { fastMode: true } : {}),
      ...(effort === "ultracode" ? { ultracode: true } : {}),
    };

    const queryOptions: ClaudeQueryOptions = {
      cwd: options.cwd,
      // The user's own Claude Code, resolved to something spawnable. Left
      // unset, the SDK hunts for the copy it ships as an optional dependency
      // and cannot find it from a bundled main process. See claudeExecutable.
      pathToClaudeCodeExecutable: resolveClaudeExecutable(options.command),
      // The SDK hands the child `process.env` untouched, so it needs the same
      // guard `spawnAgent` applies to Codex: a Luu Code started from a shell
      // that exports ELECTRON_RUN_AS_NODE would otherwise pass it down, and a
      // CLI that happens to be an Electron app starts as plain Node instead of
      // as itself.
      env: agentEnvironment(),
      ...(model ? { model } : {}),
      // The preset carries how Claude Code works; the append carries where it
      // is. Without the second half it reasons about the game as files.
      systemPrompt: { type: "preset", preset: "claude_code", append: briefingFor(options.projectRules) },
      ...(sdkEffort(effort) ? { effort: sdkEffort(effort) } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      // Luu Code's Roblox tools, handed to the agent as an MCP server.
      mcpServers: {
        "luu-code": { command: options.mcp.command, args: options.mcp.args, env: options.mcp.env },
      },
      /**
       * Luu Code is the permission system, so the CLI's is turned off.
       *
       * This is not a shortcut. Every Roblox operation is already checked
       * against the user's own permission groups by the server behind the MCP
       * tools, where the user can see them and revoke them mid-conversation.
       * The CLI's layer exists to protect a filesystem this session does not
       * have, and it has no way to ask anyone anything: `acceptEdits` covers
       * file edits and nothing else, so every MCP call went to a prompt that no
       * one could answer and came back to the model as "user cancelled MCP tool
       * call". There was no user, and nobody cancelled anything.
       *
       * What the filesystem tools would have reached is removed outright
       * instead, which is a stronger guarantee than refusing them one call at a
       * time — the model never sees them.
       */
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: NO_FILESYSTEM_HERE,
      abortController: abort,
    };

    try {
      for await (const message of query({ prompt: this.prompts(abort.signal), options: queryOptions })) {
        this.handle(message, options);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        options.onEvent({ type: "error", message: describe(error) });
        options.onEvent({ type: "state", state: "error" });
      }
    } finally {
      this.abort = null;
      if (this.active) options.onEvent({ type: "state", state: "idle" });
    }
  }

  /**
   * Feeds queued messages to the SDK, staying open between turns so a follow-up
   * continues the same conversation instead of starting another process.
   */
  private async *prompts(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) yield next;
      }

      if (signal.aborted || !this.active) return;

      await new Promise<void>((resolve) => {
        this.notify = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });

      this.notify = null;
    }
  }

  private handle(message: SDKMessage, options: StartOptions): void {
    const emit = options.onEvent;

    if (message.type === "system" && message.subtype === "init") {
      this.sessionId = message.session_id;
      emit({ type: "session", sessionId: message.session_id, model: message.model ?? null });
      return;
    }

    if (message.type === "assistant") {
      let sawTool = false;

      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          emit({ type: "assistant", id: nextId("m"), text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          emit({ type: "thinking", id: nextId("t"), text: block.thinking });
        } else if (block.type === "tool_use") {
          sawTool = true;
          emit({ type: "tool-use", id: block.id, name: block.name, input: block.input });
        }
      }

      emit({ type: "state", state: sawTool ? "working" : "thinking" });
      return;
    }

    if (message.type === "user") {
      const content = message.message.content;
      if (typeof content === "string") return;

      for (const block of content) {
        if (block.type !== "tool_result") continue;
        emit({
          type: "tool-result",
          id: block.tool_use_id,
          isError: block.is_error === true,
          text: renderToolResult(block.content),
        });
      }
      return;
    }

    if (message.type === "result") {
      emit({ type: "turn-complete", summary: "result" in message ? String(message.result ?? "") : null });
      emit({ type: "state", state: "idle" });
    }
  }

  interrupt(): void {
    this.abort?.abort();
    this.abort = null;
    this.options?.onEvent({ type: "state", state: "idle", message: "Interrupted." });
  }

  async stop(): Promise<void> {
    this.active = false;
    this.abort?.abort();
    this.abort = null;
    this.queue = [];
    this.notify?.();
    this.options?.onEvent({ type: "state", state: "stopped" });
  }
}

function userMessage(text: string, attachments: Attachment[]): SDKUserMessage {
  // Images first: the model reads the picture, then the instruction about it.
  const content = [
    ...attachments.map((attachment) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.mimeType, data: attachment.data },
    })),
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
  ];

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const entry = block as { type?: string; text?: string };
        if (entry.type === "text") return entry.text ?? "";
        if (entry.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return content === undefined ? "" : JSON.stringify(content);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/not authenticated|login|unauthorized/i.test(message)) {
    return `${message}\n\nRun \`claude\` once in a terminal to sign in.`;
  }

  if (/ENOENT|not found/i.test(message)) {
    return `${message}\n\nClaude Code was not found. Install it from https://claude.com/claude-code.`;
  }

  return message;
}
