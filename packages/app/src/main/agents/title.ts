/**
 * Naming a conversation. A one-shot, read-only call to the CLI the user already
 * has, never to the conversation's own session — a title cannot consume the
 * agent's context or appear in its transcript.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInfo } from "../../shared/agent.js";
import { defaultModelFor } from "../../shared/models.js";
import { DEFAULT_TITLE_MODEL, autoTitleProvider } from "../../shared/settings.js";
import type { AppSettings } from "../../shared/settings.js";
import { spawnAgent } from "./adapter.js";
import { CODEX_VARIANT } from "./codex.js";
import type { CodexVariant } from "./codex.js";
import { OLLAMA_VARIANT } from "./ollama.js";

/** The rules the naming model is given. */
const PROMPT = `Generate a title that will help the user recognize this Luu Code thread weeks later.
Luu Code threads are about a Roblox experience: the subject is a system, feature, or bug inside the game.

Before answering, silently reduce the request to:
- Subject: what system, feature, or problem is this really about?
- Outcome: what does the user ultimately want to change or understand?
- Incidental instructions: what only describes how the agent should work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or a clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the game change, not the playtest, screenshot, or script used to find it.
- Do not name the place, the agent, the model, or Roblox Studio itself.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- No quotes, labels, filler, or trailing punctuation.`;

/** Codex returns structured output, so it gets a schema to fill in. */
const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

const TIMEOUT_MS = 45_000;

/** Which CLI names the thread: the configured one, or this machine's default. */
export function titleProvider(settings: AppSettings, agents: AgentInfo[]): AgentInfo | null {
  const installed = agents.filter((agent) => agent.installed && agent.command);
  const chosen = settings.titleGeneration.provider;

  if (chosen !== "auto") return installed.find((agent) => agent.id === chosen) ?? null;

  const preferred = autoTitleProvider(installed.map((agent) => agent.id));
  return installed.find((agent) => agent.id === preferred) ?? installed[0] ?? null;
}

export async function generateTitle(
  agent: AgentInfo,
  settings: AppSettings,
  message: string,
  cwd: string,
): Promise<string | null> {
  if (!agent.command) return null;

  // A local provider has no small model of its own, so the catalogue answers
  // when the table cannot.
  const model = settings.titleGeneration.model ?? DEFAULT_TITLE_MODEL[agent.id] ?? defaultModelFor(agent.id)?.slug;
  if (!model) return null;

  const prompt = `${PROMPT}\n\nUser message:\n${message.slice(0, 8_000)}`;

  try {
    const raw =
      agent.id === "claude"
        ? await runClaude(agent.command, model, prompt, cwd)
        : await runCodex(agent.command, model, prompt, cwd, agent.id === "ollama" ? OLLAMA_VARIANT : CODEX_VARIANT);

    return sanitize(raw);
  } catch {
    // A missing title is cosmetic; the thread keeps the typed first line.
    return null;
  }
}

/**
 * `claude -p` prints one answer and exits; the call has no tools, so
 * permissions are skipped. The title is asked for as text, not through
 * `--json-schema` — a `.cmd` shim eats the quotes and the schema arrives
 * invalid.
 */
async function runClaude(command: string, model: string, prompt: string, cwd: string): Promise<string> {
  const stdout = await run(
    command,
    ["-p", "--output-format", "json", "--model", model, "--dangerously-skip-permissions"],
    `${prompt}\n\nReply with the title and nothing else: no JSON, no code fence, no preamble.`,
    cwd,
  );

  const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  if (envelope.is_error) throw new Error("Claude Code reported an error.");

  return typeof envelope.result === "string" ? envelope.result : "";
}

/**
 * Codex writes its answer to a file rather than stdout, so the schema and the
 * output both go through a scratch directory. An Ollama model gets neither the
 * schema nor a reasoning effort — asking a local model for either fails the
 * call — and `sanitize` copes with the plain line that comes back.
 */
async function runCodex(
  command: string,
  model: string,
  prompt: string,
  cwd: string,
  variant: CodexVariant,
): Promise<string> {
  const local = variant.id !== "codex";
  const directory = mkdtempSync(join(tmpdir(), "luu-title-"));
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "title.json");

  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  writeFileSync(outputPath, "");

  try {
    await run(
      command,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--model",
        model,
        ...variant.overrides,
        ...(local ? [] : ["--config", "model_reasoning_effort='low'", "--output-schema", schemaPath]),
        "--output-last-message",
        outputPath,
        "-",
      ],
      prompt,
      cwd,
    );

    const written = readFileSync(outputPath, "utf8").trim();
    if (local) return written;

    return String((JSON.parse(written) as { title?: unknown }).title ?? "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(command: string, args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnAgent(command, args, cwd);

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Title generation timed out."));
    }, TIMEOUT_MS);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Exited with code ${code ?? "unknown"}.`));
    });

    child.stdin.end(stdin);
  });
}

/** A model asked for one line still sometimes sends a fenced JSON blob. */
function sanitize(raw: string): string | null {
  const unfenced = raw.replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, "").trim();

  const structured = unfenced.startsWith("{") ? tryParseTitle(unfenced) : null;
  const cleaned = (structured ?? unfenced)
    .replace(/\s+/g, " ")
    .replace(/^["'`\s]+|["'`\s.]+$/g, "")
    .trim();

  if (cleaned.length === 0) return null;
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

function tryParseTitle(value: string): string | null {
  try {
    const title = (JSON.parse(value) as { title?: unknown }).title;
    return typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}
