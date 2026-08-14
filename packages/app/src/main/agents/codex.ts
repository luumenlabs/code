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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, Attachment } from "../../shared/agent.js";
import type { ModelSelection } from "../../shared/models.js";
import { JsonLineReader, describeExit, extensionFor, nextId, spawnAgent } from "./adapter.js";
import { withBriefing } from "./briefing.js";
import type { AgentAdapter, StartOptions } from "./adapter.js";

/**
 * Which backend a Codex session talks to.
 *
 * The CLI is the same either way — `codex exec`, the same JSON stream, the same
 * MCP wiring, the same interrupt. What differs between OpenAI's models and the
 * ones on the user's own machine is which provider Codex is pointed at, and
 * that is two config overrides. So Ollama is a variant of this adapter rather
 * than an adapter of its own: a second copy of this file would drift the first
 * time Codex's event shape moved, and it has moved several times already.
 */
export interface CodexVariant {
  /** The provider this session is filed under, and the rail it appears on. */
  id: AgentId;
  /** What to call it in a sentence the user reads. */
  label: string;
  /** Overrides that decide which backend serves the model. */
  overrides: string[];
  /** What to suggest when the CLI exits without saying why. */
  exitHint: string;
  /**
   * Advisory lines the CLI reports as errors but which the user cannot act on.
   * Kept deliberately narrow: anything not matched here is still shown.
   */
  benign?: RegExp;
}

export const CODEX_VARIANT: CodexVariant = {
  id: "codex",
  label: "Codex",
  overrides: [],
  exitHint: "Run it once in a terminal to check that it is signed in.",
};

/**
 * A TOML string, preferring the literal form.
 *
 * `'C:\Users\me'` needs no backslash doubling and, more importantly, carries no
 * double quotes — which is what a Windows command line eats. The escaped form
 * is only used for the rare value that contains a single quote.
 */
function toml(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Attachments live in the transcript as base64, but Codex only takes paths, so
 * they are spilled to a temp directory the OS will clean up.
 */
function writeAttachments(attachments: Attachment[]): string[] {
  if (attachments.length === 0) return [];

  const directory = mkdtempSync(join(tmpdir(), "luu-code-"));

  return attachments.map((attachment, index) => {
    const path = join(directory, `${index + 1}.${extensionFor(attachment.mimeType)}`);
    writeFileSync(path, Buffer.from(attachment.data, "base64"));
    return path;
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Codex's event shape is
   whatever the installed CLI sends; these readers exist to survive that. */

/**
 * A tool call's id, made unique across the conversation.
 *
 * Codex's own id is only unique within one turn: the modern stream numbers
 * items `item_0`, `item_1`, and starts again from zero on the next `codex
 * exec`. The transcript stores rows by id and replaces what it already has, so
 * the second turn's first tool call landed on the first turn's first tool call
 * — a shell command showing an MCP call's output, which is a lie about what the
 * agent did rather than a cosmetic glitch.
 *
 * The turn number is the scope Codex leaves out. Begin and end events inside
 * one turn still agree, which is the property the pairing depends on.
 */
function callId(turn: string, item: Record<string, any>): string {
  const own = item.id ?? item.call_id ?? item.callId ?? item.tool_call_id;
  return own === undefined ? nextId("tool") : `t${turn}_${String(own)}`;
}

/**
 * The tool name, in the form the rest of the app uses.
 *
 * Codex names an MCP tool by its server and its tool; Claude Code's client
 * flattens the two into `mcp__server__tool`. Everything downstream — including
 * the rule that decides whether a call is a Roblox operation and belongs in the
 * transcript as one — was written against the second form. Normalising here is
 * the adapter doing its job: absorbing the difference so nothing after it has
 * to know which CLI is running.
 */
function mcpToolName(item: Record<string, any>): string {
  const tool = String(item.tool ?? item.tool_name ?? item.name ?? "mcp");
  const server = item.server ?? item.server_name ?? item.serverName;

  if (typeof server === "string" && server.length > 0) return `mcp__${server}__${tool}`;
  return tool;
}

/** Arguments arrive as an object or as a JSON string, depending on the release. */
function toolInput(item: Record<string, any>): unknown {
  const raw = item.arguments ?? item.input ?? item.args ?? item.parameters ?? {};
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function output(item: Record<string, any>): string {
  const value =
    item.output ?? item.result ?? item.stdout ?? item.aggregated_output ?? item.content ?? item.error ?? "";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function failed(item: Record<string, any>): boolean {
  if (item.success === false || item.is_error === true) return true;
  if (typeof item.status === "string" && /fail|error|cancel/i.test(item.status)) return true;
  return typeof item.exit_code === "number" && item.exit_code !== 0;
}

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId;

  constructor(private readonly variant: CodexVariant = CODEX_VARIANT) {
    this.id = variant.id;
  }

  private options: StartOptions | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private hasConversation = false;
  private stderr = "";
  /**
   * Scopes Codex's per-turn item ids to this conversation.
   *
   * The counter alone is not enough: a thread reopened after a restart starts
   * counting at one again, and its transcript already holds rows from the first
   * time it ran. The launch stamp is what keeps the second session's first turn
   * from landing on the first session's.
   */
  private readonly run = Date.now().toString(36);
  private turn = 0;

  get running(): boolean {
    return this.started;
  }

  private resumeId: string | null = null;

  /**
   * Messages typed while a turn was running. Codex closes stdin when a turn
   * starts, so they go in as the turn that follows rather than being dropped.
   */
  private queued: Array<{ text: string; attachments: Attachment[] }> = [];

  async start(options: StartOptions): Promise<void> {
    this.options = options;
    this.started = true;
    this.resumeId = options.resumeSessionId ?? null;
    // With a stored session id the next turn resumes that conversation instead
    // of starting a new one.
    this.hasConversation = this.resumeId !== null;
    options.onEvent({ type: "state", state: "idle" });
  }

  setModelSelection(selection: ModelSelection | null): void {
    if (!this.options) return;
    // Every turn is its own `codex exec`, so the next one simply gets different
    // config overrides.
    this.options = { ...this.options, ...(selection ? { modelSelection: selection } : { modelSelection: undefined }) };
  }

  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    const options = this.options;
    if (!options) throw new Error(`${this.variant.label} is not running.`);

    if (this.child) {
      this.queued.push({ text, attachments });
      return;
    }

    this.turnFor(options, text, attachments);
  }

  /** Joined into one message: consecutive corrections are one thing to say. */
  private takeQueued(): { text: string; attachments: Attachment[] } | null {
    if (this.queued.length === 0) return null;

    const pending = this.queued;
    this.queued = [];

    return {
      text: pending.map((entry) => entry.text).filter((entry) => entry.length > 0).join("\n\n"),
      attachments: pending.flatMap((entry) => entry.attachments),
    };
  }

  private turnFor(options: StartOptions, text: string, attachments: Attachment[]): void {
    // Config overrides rather than a config file, so the user's own
    // ~/.codex/config.toml is never rewritten by Luu Code.
    const selection = options.modelSelection;
    const effort = selection?.options.find((entry) => entry.id === "reasoningEffort")?.value;
    const tier = selection?.options.find((entry) => entry.id === "serviceTier")?.value;

    const overrides = [
      // Which backend serves the model. Empty for Codex's own; for Ollama it is
      // the provider pointing at the daemon on this machine.
      ...this.variant.overrides,
      /**
       * Nobody is here to approve anything.
       *
       * A sandboxed Codex session treats an MCP call as leaving the sandbox
       * and asks first. `codex exec` has no one to ask, so the request is
       * dropped and the model is told "user cancelled MCP tool call" — no user
       * was asked, and nothing was cancelled. Every Roblox tool call failed
       * this way, which made Luu Code look disconnected when it was paired and
       * working.
       *
       * Measured, not guessed: with `workspace-write` the call is cancelled,
       * with `danger-full-access` the same call returns. The approval policy on
       * its own changes nothing either way.
       *
       * The trade this makes is real and worth stating. Codex's sandbox guards
       * the filesystem, and the filesystem it would be guarding here is an
       * empty scratch folder that holds none of the user's work — the game
       * lives in Studio. The boundary that matters for this product is Luu
       * Code's own permissions, which every Roblox operation is checked
       * against, and which the user can see and revoke mid-conversation. What
       * is given up is protection against a shell command the agent was told
       * not to run, in a directory with nothing in it.
       *
       * Set as a config override rather than with `-s`, which is the same
       * setting by a name only some of these commands know. `codex exec` takes
       * `-s`; `codex exec resume` does not, and rejects the whole invocation
       * with "unexpected argument '-s' found". That failed every turn after the
       * first, which reads as the agent giving up mid-task rather than as a
       * command line that was never valid. `-c` is accepted by both, and is
       * checked here against `--strict-config`.
       */
      "-c",
      `sandbox_mode=${toml("danger-full-access")}`,
      "-c",
      `approval_policy=${toml("never")}`,
      "-c",
      `mcp_servers.luu-code.command=${toml(options.mcp.command)}`,
      "-c",
      `mcp_servers.luu-code.args=[${options.mcp.args.map(toml).join(",")}]`,
      "-c",
      `mcp_servers.luu-code.env={${Object.entries(options.mcp.env)
        .map(([key, value]) => `${key}=${toml(value)}`)
        .join(",")}}`,
      ...(selection ? ["-c", `model=${toml(selection.model)}`] : []),
      ...(typeof effort === "string" ? ["-c", `model_reasoning_effort=${toml(effort)}`] : []),
      // "default" is Luu Code's name for "say nothing and take Codex's own".
      ...(typeof tier === "string" && tier !== "default" ? ["-c", `service_tier=${toml(tier)}`] : []),
    ];

    // Resuming by id targets the exact conversation the thread belongs to;
    // --last would pick up whatever Codex ran most recently, which may be a
    // different thread entirely.
    const resumeTarget = this.resumeId ? [this.resumeId] : ["--last"];

    // Codex takes images as file paths, so attachments are written out first.
    const images = writeAttachments(attachments).flatMap((path) => ["-i", path]);

    // The prompt goes in on stdin ("-"), never as an argument: a message is
    // arbitrary user text, and arbitrary user text has no business on a command
    // line.
    const args = this.hasConversation
      ? ["exec", "resume", ...resumeTarget, "--json", "--skip-git-repo-check", ...images, ...overrides, "-"]
      : ["exec", "--json", "--skip-git-repo-check", ...images, ...overrides, "-"];

    this.stderr = "";
    this.turn += 1;
    options.onEvent({ type: "state", state: "thinking" });

    const child = spawnAgent(options.command, args, options.cwd);
    this.child = child;
    // Codex has no system-prompt channel, so where it is rides in front of the
    // first message. A resumed conversation already has it in context.
    child.stdin.end(this.hasConversation ? text : withBriefing(text, options.rules));

    const reader = new JsonLineReader((value, raw) => this.handle(value, raw));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
    });

    child.on("error", (error) => {
      options.onEvent({ type: "error", message: `Could not start ${this.variant.label}: ${error.message}` });
      options.onEvent({ type: "state", state: "error" });
      this.child = null;
      this.dropQueued(options, "it could not be started");
    });

    child.on("exit", (code) => {
      reader.flush();
      this.child = null;

      if (code !== 0) {
        options.onEvent({
          type: "error",
          message: describeExit(this.variant.label, code, this.stderr, this.variant.exitHint),
        });
        options.onEvent({ type: "state", state: "error" });
        // Not drained after a failure: it would loop.
        this.dropQueued(options, "the turn before it failed");
        return;
      }

      this.hasConversation = true;
      options.onEvent({ type: "turn-complete", summary: null });

      const next = this.takeQueued();
      if (next) {
        this.turnFor(options, next.text, next.attachments);
        return;
      }

      options.onEvent({ type: "state", state: "idle" });
    });
  }

  /** A message that will never be sent is said so, not dropped in silence. */
  private dropQueued(options: StartOptions, because: string): void {
    const abandoned = this.takeQueued();
    if (!abandoned) return;

    options.onEvent({
      type: "error",
      message: `This was not sent to ${this.variant.label}, because ${because}:\n\n${abandoned.text}`,
    });
  }

  interrupt(): void {
    this.child?.kill("SIGINT");
    this.child = null;
    // Stop means stop, including anything typed while the turn was running.
    this.queued = [];
    this.options?.onEvent({ type: "state", state: "idle", message: "Interrupted." });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.queued = [];
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

    /**
     * Whether this event is the end of the call as well as the call.
     *
     * Older Codex sent a begin event and a matching end event. Newer Codex
     * sends one completed item carrying the command *and* its output, and no
     * end event at all — so a row that only emitted `tool-use` sat spinning
     * for the rest of the conversation, because the result it was waiting for
     * had already arrived inside the event that created it.
     */
    const envelope = String(event.type ?? "");
    const finished = envelope === "item.completed" || envelope === "item.failed";

    // `thread.started` is what a current Codex sends, and it carries the id
    // under `thread_id`. Without it `resumeId` stayed null and every follow-up
    // resumed with `--last` — whichever conversation Codex ran most recently,
    // which with several chats open is routinely a different one.
    if (kind === "session.created" || kind === "session_configured" || kind === "thread.started") {
      const sessionId = String(item.session_id ?? item.sessionId ?? item.thread_id ?? item.threadId ?? "");
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
      const id = callId(`${this.run}_${this.turn}`, item);
      emit({ type: "tool-use", id, name: "shell", input: item.command ?? item.parsed_cmd ?? {} });
      if (finished) emit({ type: "tool-result", id, isError: failed(item), text: output(item) });
      return;
    }

    if (kind === "mcp_tool_call" || kind === "mcp_tool_call_begin") {
      const id = callId(`${this.run}_${this.turn}`, item);
      emit({ type: "tool-use", id, name: mcpToolName(item), input: toolInput(item) });
      if (finished) emit({ type: "tool-result", id, isError: failed(item), text: output(item) });
      return;
    }

    if (kind === "mcp_tool_call_end" || kind === "exec_command_end" || kind === "command_execution_output") {
      emit({ type: "tool-result", id: callId(`${this.run}_${this.turn}`, item), isError: failed(item), text: output(item) });
      return;
    }

    if (kind === "error" || kind === "stream_error") {
      const message = String(item.message ?? item.error ?? `${this.variant.label} reported an error`);

      // Some of what the CLI calls an error is a note about itself rather than
      // something that went wrong with the turn, and it repeats every turn.
      if (this.variant.benign?.test(message)) return;

      emit({ type: "error", message });
    }
  }
}
