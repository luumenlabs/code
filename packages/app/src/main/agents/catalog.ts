/**
 * What models the user can actually run. Codex answers over the app-server
 * protocol, so it is asked. Claude Code has no equivalent call, so its
 * catalogue is declared and gated on the installed CLI version.
 */
import type { AgentInfo } from "../../shared/agent.js";
import { CLAUDE_MODELS, CODEX_FALLBACK_MODELS, compareVersions } from "../../shared/models.js";
import type { ModelInfo, OptionChoice, OptionDescriptor } from "../../shared/models.js";
import { JsonLineReader, spawnAgent } from "./adapter.js";
import { discoverOllamaModels } from "./ollama.js";

/** Codex's own labels for reasoning levels; anything new passes through. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** Codex marks nothing as legacy, so the current generation is named here. */
const CURRENT_CODEX_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

/** Preferred defaults when Codex offers several; its own flag wins otherwise. */
const PREFERRED_CODEX_DEFAULTS = ["gpt-5.6-sol", "gpt-5.6-terra"];

const STANDARD_TIER = "default";

interface CodexServiceTier {
  id: string;
  name: string;
  description?: string;
}

interface CodexModel {
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  serviceTiers?: CodexServiceTier[];
  additionalSpeedTiers?: string[];
  defaultServiceTier?: string | null;
}

export interface CatalogResult {
  models: ModelInfo[];
  /** Why the Codex list is the fallback rather than the live one, if it is. */
  problem: string | null;
}

/** Codex sends the display name inconsistently cased. */
function displayName(model: CodexModel): string {
  return model.displayName.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, letter: string) => `-${letter.toUpperCase()}`);
}

function codexOptions(model: CodexModel): OptionDescriptor[] {
  const options: OptionDescriptor[] = [];

  const efforts: OptionChoice[] = model.supportedReasoningEfforts.map((entry) => ({
    value: entry.reasoningEffort,
    label: EFFORT_LABELS[entry.reasoningEffort] ?? entry.reasoningEffort,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}),
  }));

  if (efforts.length > 0) {
    options.push({ id: "reasoningEffort", label: "Reasoning", kind: "select", choices: efforts });
  }

  // `serviceTiers` replaced `additionalSpeedTiers`; older CLIs still send the latter.
  const tiers: CodexServiceTier[] =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({ id, name: id === "fast" ? "Fast" : id }));

  if (tiers.length > 0) {
    const declared = tiers.some((tier) => tier.id === model.defaultServiceTier) ? model.defaultServiceTier : null;
    const active = declared ?? STANDARD_TIER;

    options.push({
      id: "serviceTier",
      label: "Service Tier",
      kind: "select",
      choices: [
        { value: STANDARD_TIER, label: "Standard", ...(active === STANDARD_TIER ? { isDefault: true } : {}) },
        ...tiers.map((tier) => ({
          value: tier.id,
          label: tier.name,
          ...(tier.description ? { description: tier.description } : {}),
          ...(active === tier.id ? { isDefault: true } : {}),
        })),
      ],
    });
  }

  return options;
}

function toModelInfo(model: CodexModel): ModelInfo {
  return {
    slug: model.model,
    name: displayName(model),
    provider: "codex",
    ...(model.description ? { description: model.description } : {}),
    ...(CURRENT_CODEX_MODELS.has(model.model) ? {} : { legacy: true }),
    ...(model.isDefault ? { isDefault: true } : {}),
    options: codexOptions(model),
  };
}

/** Our ranking wins when it is available; otherwise Codex's own flag stands. */
function applyPreferredDefault(models: ModelInfo[]): ModelInfo[] {
  const preferred = PREFERRED_CODEX_DEFAULTS.find((slug) => models.some((model) => model.slug === slug));
  if (!preferred) return models;

  return models.map((model) => {
    if (model.slug === preferred) return { ...model, isDefault: true };
    if (!model.isDefault) return model;

    const { isDefault: _drop, ...rest } = model;
    return rest;
  });
}

/**
 * A single JSON-RPC conversation with `codex app-server`. The process is
 * started, asked what it can do, and shut down again — this runs on a refresh,
 * not on every turn.
 */
async function askCodex(command: string, timeoutMs: number): Promise<CodexModel[]> {
  const child = spawnAgent(command, ["app-server"], process.cwd());

  let nextId = 0;
  const pending = new Map<number, (result: unknown, error: unknown) => void>();

  const reader = new JsonLineReader((value) => {
    if (typeof value !== "object" || value === null) return;

    const message = value as { id?: number; result?: unknown; error?: unknown };
    if (typeof message.id !== "number") return;

    const settle = pending.get(message.id);
    if (!settle) return;

    pending.delete(message.id);
    settle(message.result, message.error);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => reader.push(chunk));

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });

  const request = <T>(method: string, params: unknown): Promise<T> => {
    const id = (nextId += 1);

    return new Promise<T>((resolve, reject) => {
      pending.set(id, (result, error) => {
        if (error) reject(new Error(describeRpcError(error)));
        else resolve(result as T);
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const notify = (method: string, params: unknown): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const failed = new Promise<never>((_resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("exit", (code) =>
      reject(new Error(stderr.trim() || `codex app-server exited with code ${code ?? "unknown"}.`)),
    );
    setTimeout(() => reject(new Error("codex app-server did not answer in time.")), timeoutMs).unref?.();
  });

  const conversation = (async (): Promise<CodexModel[]> => {
    await request("initialize", {
      clientInfo: { name: "luu-code", title: "Luu Code", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    notify("initialized", undefined);

    // Signed out, Codex answers `model/list` with an empty catalogue, not an error.
    const account = await request<{ account: unknown; requiresOpenaiAuth?: boolean }>("account/read", {});
    if (!account.account) {
      throw new Error("Codex is not signed in. Run `codex` once in a terminal to authenticate.");
    }

    const models: CodexModel[] = [];
    let cursor: string | null | undefined;

    do {
      const page = await request<{ data: CodexModel[]; nextCursor?: string | null }>(
        "model/list",
        cursor ? { cursor } : {},
      );
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);

    return models;
  })();

  try {
    return await Promise.race([conversation, failed]);
  } finally {
    child.kill();
  }
}

function describeRpcError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(error);
}

export async function discoverCodexModels(
  command: string,
  timeoutMs = 20_000,
): Promise<{ models: ModelInfo[]; problem: string | null }> {
  try {
    const models = await askCodex(command, timeoutMs);
    const usable = models.filter((model) => !model.hidden).map(toModelInfo);

    if (usable.length === 0) {
      return { models: CODEX_FALLBACK_MODELS, problem: "Codex reported no models." };
    }

    return { models: applyPreferredDefault(usable), problem: null };
  } catch (error) {
    return {
      models: CODEX_FALLBACK_MODELS,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Claude Code's models for the installed version. A model the CLI is too old to
 * launch is left out rather than shown and failed on send.
 */
export function claudeModelsFor(version: string | null): ModelInfo[] {
  const installed = version?.match(/\d+(?:\.\d+)*/)?.[0] ?? null;

  return CLAUDE_MODELS.filter((model) => {
    if (!model.minCliVersion) return true;
    if (!installed) return false;
    return compareVersions(installed, model.minCliVersion) >= 0;
  }).map(({ minCliVersion: _drop, ...model }) => model);
}

/** Models the installed providers currently offer, plus why Codex's list is stale. */
export async function discoverModels(agents: AgentInfo[]): Promise<CatalogResult> {
  const claude = agents.find((agent) => agent.id === "claude");
  const codex = agents.find((agent) => agent.id === "codex");
  const ollama = agents.find((agent) => agent.id === "ollama");

  const claudeModels = claude?.installed ? claudeModelsFor(claude.version) : [];

  // Asked together: the local daemon answers in milliseconds, Codex in seconds.
  const [codexResult, ollamaModels] = await Promise.all([
    codex?.installed && codex.command
      ? discoverCodexModels(codex.command)
      : Promise.resolve({ models: [] as ModelInfo[], problem: null }),
    ollama?.installed ? discoverOllamaModels() : Promise.resolve([] as ModelInfo[]),
  ]);

  return {
    models: [...claudeModels, ...codexResult.models, ...ollamaModels],
    problem: codexResult.problem,
  };
}
