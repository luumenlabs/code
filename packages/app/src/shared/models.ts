/**
 * Model catalogue and per-model options.
 *
 * The shape follows T3 Code: a provider offers models, and each model declares
 * its own option descriptors. The picker is generic — it renders whatever the
 * selected model declares — so adding a model with a different set of knobs
 * needs no UI change. Claude Opus 5 has Fast Mode; Fable 5 does not, and the
 * menu reflects that without a special case.
 */
import type { AgentId } from "./agent.js";

export type OptionValue = string | boolean;

export interface OptionChoice {
  value: string;
  label: string;
  isDefault?: boolean;
}

export type OptionDescriptor =
  | { id: string; label: string; kind: "select"; choices: OptionChoice[] }
  | { id: string; label: string; kind: "boolean"; default?: boolean };

export interface ModelInfo {
  slug: string;
  name: string;
  /** Shown under the name in the picker. */
  provider: AgentId;
  /** Current models sit above the "Legacy models" divider. */
  legacy?: boolean;
  options: OptionDescriptor[];
}

export interface ModelSelection {
  model: string;
  options: Array<{ id: string; value: OptionValue }>;
}

/**
 * Reasoning levels. `ultrathink` is injected into the prompt rather than sent
 * as an API effort, and `ultracode` is a Claude Code setting that rides along
 * with `xhigh`; both are normalised on the way to the SDK.
 */
const CLAUDE_EFFORT: OptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
    { value: "ultrathink", label: "Ultrathink" },
  ],
};

const CLAUDE_CONTEXT: OptionDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  kind: "select",
  choices: [
    { value: "200k", label: "200k" },
    { value: "1m", label: "1M", isDefault: true },
  ],
};

const FAST_MODE: OptionDescriptor = { id: "fastMode", label: "Fast Mode", kind: "boolean" };

const CODEX_EFFORT: OptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
};

export const MODELS: ModelInfo[] = [
  { slug: "claude-fable-5", name: "Claude Fable 5", provider: "claude", options: [CLAUDE_EFFORT, CLAUDE_CONTEXT] },
  { slug: "claude-opus-5", name: "Claude Opus 5", provider: "claude", options: [CLAUDE_EFFORT, FAST_MODE, CLAUDE_CONTEXT] },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude", options: [CLAUDE_EFFORT, FAST_MODE, CLAUDE_CONTEXT] },
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "claude", legacy: true, options: [CLAUDE_EFFORT, CLAUDE_CONTEXT] },
  { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "claude", legacy: true, options: [CLAUDE_EFFORT] },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude", legacy: true, options: [] },

  { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "codex", options: [CODEX_EFFORT] },
  { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "codex", options: [CODEX_EFFORT] },
  { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "codex", options: [CODEX_EFFORT] },
  { slug: "gpt-5.4", name: "GPT-5.4", provider: "codex", legacy: true, options: [CODEX_EFFORT] },
];

export const DEFAULT_MODEL_BY_AGENT: Record<AgentId, string> = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-sol",
};

export function modelsFor(agent: AgentId): ModelInfo[] {
  return MODELS.filter((model) => model.provider === agent);
}

export function findModel(slug: string | null | undefined): ModelInfo | undefined {
  return MODELS.find((model) => model.slug === slug);
}

export function defaultValue(descriptor: OptionDescriptor): OptionValue | undefined {
  if (descriptor.kind === "boolean") return descriptor.default ?? false;
  return descriptor.choices.find((choice) => choice.isDefault)?.value;
}

export function optionValue(selection: ModelSelection | null | undefined, id: string): OptionValue | undefined {
  return selection?.options.find((entry) => entry.id === id)?.value;
}

/** Reads an option, falling back to the descriptor's declared default. */
export function effectiveOption(
  selection: ModelSelection | null | undefined,
  descriptor: OptionDescriptor,
): OptionValue | undefined {
  return optionValue(selection, descriptor.id) ?? defaultValue(descriptor);
}

export function createSelection(agent: AgentId, model?: string): ModelSelection {
  const slug = model ?? DEFAULT_MODEL_BY_AGENT[agent];
  const info = findModel(slug);

  return {
    model: slug,
    options: (info?.options ?? []).flatMap((descriptor) => {
      const value = defaultValue(descriptor);
      return value === undefined ? [] : [{ id: descriptor.id, value }];
    }),
  };
}

export function withOption(selection: ModelSelection, id: string, value: OptionValue): ModelSelection {
  const others = selection.options.filter((entry) => entry.id !== id);
  return { ...selection, options: [...others, { id, value }] };
}

/**
 * Short label for the composer chip, for example "High · 1M" — the settings
 * that actually change the answer, in the order the menu shows them.
 */
export function describeOptions(selection: ModelSelection | null | undefined): string {
  const info = findModel(selection?.model);
  if (!info || !selection) return "";

  const parts: string[] = [];

  for (const descriptor of info.options) {
    const value = effectiveOption(selection, descriptor);
    if (value === undefined) continue;

    if (descriptor.kind === "boolean") {
      if (value === true) parts.push(descriptor.label);
      continue;
    }

    const choice = descriptor.choices.find((entry) => entry.value === value);
    if (choice) parts.push(choice.label);
  }

  return parts.join(" · ");
}
