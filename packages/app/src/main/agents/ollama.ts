/**
 * Ollama — the models already on the user's machine.
 *
 * A provider in the picker and a variant of the Codex adapter underneath: the
 * Codex CLI talks to Ollama through its built-in `ollama` model provider, so an
 * Ollama session needs Codex installed. The catalogue is discovered, since
 * which models exist is a fact about this machine.
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
 * Which daemon is meant. Read from `OLLAMA_HOST` because Codex reads it too —
 * the listed models and the server Codex talks to have to be the same one.
 */
export function ollamaHost(): string {
  const configured = process.env.OLLAMA_HOST?.trim();
  if (!configured) return DEFAULT_HOST;

  const trimmed = configured.replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * How a Codex session is pointed at Ollama. `-c model_provider` rather than the
 * `--oss` flag: the adapter uses `codex exec resume`, which rejects the flag.
 */
export const OLLAMA_VARIANT: CodexVariant = {
  id: "ollama",
  label: "Ollama",
  overrides: ["-c", "model_provider='ollama'"],
  exitHint: "Check that Ollama is running and that the model has been pulled.",
  // A local tag is in no model-metadata registry, and Codex reports the miss as
  // an error every turn.
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
        // Something this large on this port is not Ollama answering.
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
 * Ollama as one more entry in the provider list. Two things have to be true and
 * they fail differently: the daemon has to answer, and the Codex CLI has to be
 * here to drive it. `command` is Codex's path.
 */
export async function describeOllama(codex: AgentInfo | undefined): Promise<AgentInfo> {
  const base = {
    id: "ollama" as const,
    label: "Ollama",
    installHint:
      "Install Ollama from https://ollama.com, start it, and pull a model that supports tools. The Codex CLI is needed too.",
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
      problem: "Ollama is running, but the Codex CLI it needs was not found.",
    };
  }

  return { ...base, command: codex.command, version: version.version ?? null, installed: true, problem: null };
}

/**
 * The models pulled on this machine. A model with no tool calling is left out —
 * everything an agent does here is a tool call. Older daemons report no
 * capabilities at all, and an unknown is not a no, so those are offered.
 */
export async function discoverOllamaModels(): Promise<ModelInfo[]> {
  const answer = await ask<{ models?: OllamaTag[] }>("/api/tags");

  return (answer?.models ?? []).flatMap(toModelInfo).sort((left, right) => left.slug.localeCompare(right.slug));
}

function toModelInfo(tag: OllamaTag): ModelInfo[] {
  const slug = tag.name?.trim();
  if (!slug) return [];
  if (tag.capabilities && !tag.capabilities.includes("tools")) return [];

  // The tag is the name: prettifying `qwen3.5:9b` would hide which of two
  // quantisations is about to run.
  const detail = [tag.details?.parameter_size, tag.details?.quantization_level].filter(Boolean).join(" · ");

  return [
    {
      slug,
      name: slug,
      provider: "ollama",
      description: detail ? `${detail} · runs on this machine` : "Runs on this machine",
      // A local model has no reasoning effort or service tier to adjust.
      options: [],
    },
  ];
}
