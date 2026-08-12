/**
 * Ollama — the models already on the user's machine.
 *
 * Luu Code ships no model and holds no API key. A local model is that same
 * bargain taken to its end: the place never leaves 127.0.0.1, and now neither
 * does the reasoning about it.
 *
 * There is no Ollama coding agent to drive, and writing one would mean this app
 * running its own tool loop — the one thing the harness deliberately does not
 * do, because then it would be the agent rather than the harness around one.
 * The Codex CLI already talks to Ollama through its built-in `ollama` model
 * provider, so that is what runs the session: the same `codex exec`, the same
 * JSON stream, the same MCP wiring, pointed at the daemon on this machine
 * instead of at OpenAI. Ollama is therefore a provider in the picker and a
 * variant of the Codex adapter underneath, and it needs the Codex CLI for the
 * same reason Claude models need Claude Code.
 *
 * The catalogue is discovered rather than declared, and here that is not a
 * nicety: which models exist is a fact about this machine and nothing else.
 */
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import type { AgentInfo } from "../../shared/agent.js";
import type { ModelInfo } from "../../shared/models.js";
import type { CodexVariant } from "./codex.js";

const DEFAULT_HOST = "http://127.0.0.1:11434";

/** Local calls answer immediately or not at all; a long wait is a wrong host. */
const TIMEOUT_MS = 2_000;

/**
 * Which daemon is meant.
 *
 * Read from `OLLAMA_HOST` because that is what Codex reads too — the list this
 * app shows and the server Codex actually talks to have to be the same one, or
 * the picker is offering models from somewhere else entirely.
 */
export function ollamaHost(): string {
  const configured = process.env.OLLAMA_HOST?.trim();
  if (!configured) return DEFAULT_HOST;

  const trimmed = configured.replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * How a Codex session is pointed at Ollama.
 *
 * `-c model_provider` rather than the `--oss` flag: `codex exec` takes the
 * flag, `codex exec resume` does not, and the adapter uses both. Overrides are
 * accepted by every form of the command, which is the same reason the sandbox
 * mode is set this way.
 */
export const OLLAMA_VARIANT: CodexVariant = {
  id: "ollama",
  label: "Ollama",
  overrides: ["-c", "model_provider='ollama'"],
  exitHint: "Check that Ollama is running and that the model has been pulled.",
  /**
   * Codex keeps a registry of model metadata — context window, pricing, tier —
   * and a local tag is in nobody's registry by definition. It reports the miss
   * as an error on every single turn, which reads in the transcript as the
   * agent failing when nothing has failed.
   */
  benign: /^Model metadata for .* not found\./,
};

interface OllamaTag {
  name?: string;
  /** Present from Ollama 0.28 or so; absent on older daemons. */
  capabilities?: string[];
  details?: { parameter_size?: string; quantization_level?: string };
}

/** A GET against the local daemon, resolving to null for every kind of no. */
function ask<T>(path: string): Promise<T | null> {
  const url = `${ollamaHost()}${path}`;
  const request = url.toLowerCase().startsWith("https:") ? getHttps : getHttp;

  return new Promise((resolve) => {
    const call = request(url, { headers: { accept: "application/json" }, timeout: TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        // Something answering on this port with something enormous is not
        // Ollama answering the question asked.
        if (body.length > 4_000_000) call.destroy();
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          resolve(null);
        }
      });
    });

    call.on("timeout", () => call.destroy());
    call.on("error", () => resolve(null));
  });
}

/**
 * Ollama as one more entry in the provider list.
 *
 * Two things have to be true for it to be usable, and they fail for different
 * reasons, so they are reported differently: the daemon has to be answering,
 * and the Codex CLI has to be here to drive it. `command` is Codex's path —
 * the adapter spawns what it is given, and what it must spawn for an Ollama
 * session is `codex`.
 */
export async function describeOllama(codex: AgentInfo | undefined): Promise<AgentInfo> {
  const base = {
    id: "ollama" as const,
    label: "Ollama",
    installHint:
      "Install Ollama from https://ollama.com, start it, and pull a model that supports tools. Ollama models are run by the Codex CLI, so that has to be installed too.",
  };

  const version = await ask<{ version?: string }>("/api/version");

  if (!version) {
    return {
      ...base,
      command: null,
      version: null,
      installed: false,
      problem: `Ollama is not answering on ${ollamaHost()}.`,
    };
  }

  if (!codex?.installed || !codex.command) {
    return {
      ...base,
      command: null,
      version: version.version ?? null,
      installed: false,
      problem: "Ollama is running, but the Codex CLI it needs to drive it was not found on this machine.",
    };
  }

  return { ...base, command: codex.command, version: version.version ?? null, installed: true, problem: null };
}

/**
 * The models pulled on this machine.
 *
 * A model with no tool calling is left out rather than shown and left to fail:
 * every single thing an agent does here is a tool call, so such a model could
 * hold a conversation about the place and never touch it. Older daemons do not
 * report capabilities at all, and an unknown is not a no — those are offered.
 */
export async function discoverOllamaModels(): Promise<ModelInfo[]> {
  const answer = await ask<{ models?: OllamaTag[] }>("/api/tags");

  return (answer?.models ?? []).flatMap(toModelInfo).sort((left, right) => left.slug.localeCompare(right.slug));
}

function toModelInfo(tag: OllamaTag): ModelInfo[] {
  const slug = tag.name?.trim();
  if (!slug) return [];
  if (tag.capabilities && !tag.capabilities.includes("tools")) return [];

  // The tag is the name: `qwen3.5:9b` is what the user pulled, what `ollama
  // list` shows them, and what they would type. Prettifying it would only
  // hide which of two quantisations they are about to run.
  const detail = [tag.details?.parameter_size, tag.details?.quantization_level].filter(Boolean).join(" · ");

  return [
    {
      slug,
      name: slug,
      provider: "ollama",
      description: detail ? `${detail} · runs on this machine` : "Runs on this machine",
      // Reasoning effort and service tiers are things a hosted provider sells.
      // A local model has neither, so there is nothing here to adjust.
      options: [],
    },
  ];
}
