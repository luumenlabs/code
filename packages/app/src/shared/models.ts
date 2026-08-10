/**
 * Model catalogue and per-model options.
 *
 * The catalogue is not a fixed list. Codex publishes its models over the
 * app-server protocol, so what the picker offers is whatever the user's own
 * `codex` reports — including models that shipped after this build. Claude Code
 * has no equivalent call, so its models are declared here and filtered by the
 * installed CLI version, since a model the CLI is too old to run is worse than
 * a model that is missing.
 *
 * Each model declares its own option descriptors and the picker renders
 * whatever it finds, so a model with a different set of knobs needs no UI
 * change: Claude Opus 5 has Fast Mode, Fable 5 does not, and Codex models carry
 * whatever reasoning efforts and service tiers the CLI advertised.
 */
import type { AgentId } from "./agent.js";

export type OptionValue = string | boolean;

export interface OptionChoice {
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export type OptionDescriptor =
  | { id: string; label: string; kind: "select"; choices: OptionChoice[] }
  | { id: string; label: string; kind: "boolean"; default?: boolean };

export interface ModelInfo {
  slug: string;
  name: string;
  /** Which CLI serves this model. Choosing the model chooses the CLI. */
  provider: AgentId;
  /** Current models sit above the "Legacy models" divider. */
  legacy?: boolean;
  /** The provider's own pick, used when the user has not chosen one. */
  isDefault?: boolean;
  /** One line from the provider, shown as a tooltip in the picker. */
  description?: string;
  /**
   * Oldest CLI version that can run this model. Claude Code only; Codex models
   * come from the running CLI, so anything it lists is by definition supported.
   */
  minCliVersion?: string;
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
const CLAUDE_EFFORT = (choices: OptionChoice[]): OptionDescriptor => ({
  id: "effort",
  label: "Reasoning",
  kind: "select",
  choices,
});

const FULL_EFFORT: OptionChoice[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultracode", label: "Ultracode" },
  { value: "ultrathink", label: "Ultrathink" },
];

const NO_ULTRACODE_EFFORT: OptionChoice[] = FULL_EFFORT.filter((choice) => choice.value !== "ultracode");

const SHORT_EFFORT: OptionChoice[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "max", label: "Max" },
  { value: "ultrathink", label: "Ultrathink" },
];

const CONTEXT_1M_DEFAULT: OptionDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  kind: "select",
  choices: [
    { value: "200k", label: "200k" },
    { value: "1m", label: "1M", isDefault: true },
  ],
};

/** Sonnet is 200k by default in Claude Code; 1M is opt-in there too. */
const CONTEXT_200K_DEFAULT: OptionDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  kind: "select",
  choices: [
    { value: "200k", label: "200k", isDefault: true },
    { value: "1m", label: "1M" },
  ],
};

const FAST_MODE: OptionDescriptor = { id: "fastMode", label: "Fast Mode", kind: "boolean" };

/**
 * Claude Code's models, with the CLI version each one needs.
 *
 * Claude Code has no "list my models" call, so this is a declared catalogue
 * rather than a discovered one. The version gate is what keeps it honest: an
 * older CLI simply does not show the models it cannot run.
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "claude",
    minCliVersion: "2.1.169",
    options: [CLAUDE_EFFORT(FULL_EFFORT), CONTEXT_1M_DEFAULT],
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "claude",
    isDefault: true,
    minCliVersion: "2.1.219",
    options: [CLAUDE_EFFORT(FULL_EFFORT), FAST_MODE, CONTEXT_1M_DEFAULT],
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "claude",
    options: [CLAUDE_EFFORT(NO_ULTRACODE_EFFORT), CONTEXT_200K_DEFAULT],
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "claude",
    legacy: true,
    minCliVersion: "2.1.154",
    options: [CLAUDE_EFFORT(FULL_EFFORT), FAST_MODE],
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "claude",
    legacy: true,
    minCliVersion: "2.1.111",
    options: [
      CLAUDE_EFFORT([
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ]),
      FAST_MODE,
    ],
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "claude",
    legacy: true,
    options: [CLAUDE_EFFORT(SHORT_EFFORT), FAST_MODE, CONTEXT_1M_DEFAULT],
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "claude",
    legacy: true,
    options: [
      CLAUDE_EFFORT([
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ]),
      FAST_MODE,
    ],
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "claude",
    legacy: true,
    options: [CLAUDE_EFFORT(SHORT_EFFORT), CONTEXT_200K_DEFAULT],
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "claude",
    legacy: true,
    options: [{ id: "thinking", label: "Thinking", kind: "boolean" }],
  },
];

/**
 * Shown only when `codex app-server` could not be reached.
 *
 * A picker with no Codex models at all reads as "Codex is unsupported", which
 * is the wrong message when the real cause is that the CLI is missing or not
 * signed in. These are the slugs that have been stable long enough to be a
 * reasonable guess; the live list replaces them entirely the moment it arrives.
 */
export const CODEX_FALLBACK_MODELS: ModelInfo[] = [
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    provider: "codex",
    isDefault: true,
    options: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        kind: "select",
        choices: [
          { value: "low", label: "Low", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
        ],
      },
    ],
  },
];

/**
 * The live catalogue.
 *
 * Held in a module variable rather than passed through every call site: the
 * adapters, the picker, and the thread store all need to resolve a slug, and
 * threading a catalogue argument through all of them buys nothing. The main
 * process sets it after probing, and the renderer sets it from each snapshot.
 */
let catalogue: ModelInfo[] = [...CLAUDE_MODELS, ...CODEX_FALLBACK_MODELS];

export function setModelCatalogue(models: ModelInfo[]): void {
  if (models.length > 0) catalogue = models;
}

export function modelCatalogue(): ModelInfo[] {
  return catalogue;
}

export function modelsFor(agent: AgentId): ModelInfo[] {
  return catalogue.filter((model) => model.provider === agent);
}

export function findModel(slug: string | null | undefined): ModelInfo | undefined {
  return catalogue.find((model) => model.slug === slug);
}

/** The provider's own default, falling back to the first model it offers. */
export function defaultModelFor(agent: AgentId): ModelInfo | undefined {
  const models = modelsFor(agent);
  return models.find((model) => model.isDefault && !model.legacy) ?? models.find((model) => !model.legacy) ?? models[0];
}

/** The model to start on when the user has never chosen one. */
export function defaultModel(): ModelInfo | undefined {
  return (
    catalogue.find((model) => model.isDefault && !model.legacy) ??
    catalogue.find((model) => !model.legacy) ??
    catalogue[0]
  );
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
  const slug = model ?? defaultModelFor(agent)?.slug ?? "";
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

/** Numeric-aware version compare, so "2.1.100" beats "2.1.99". */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (value.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }

  return 0;
}
