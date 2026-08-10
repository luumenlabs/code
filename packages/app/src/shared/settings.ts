/**
 * User settings.
 *
 * Deliberately small. Every entry here is something a user has a real reason to
 * change — not a knob added because it was easy. Anything that can be inferred
 * from the connected place or the installed CLIs is inferred instead of asked.
 */
import type { AgentId } from "./agent.js";

export interface TitleGenerationSettings {
  /**
   * Titles cost a cheap model call per conversation. On by default because
   * "Fix the inventory buy button" is worth far more in the sidebar than the
   * first sixty characters of whatever was typed, but it is a real request to
   * a real CLI, so it can be turned off.
   */
  enabled: boolean;
  /** Which CLI runs the call. Falls back to whichever one is installed. */
  provider: AgentId | "auto";
  /** Model slug, or null to use the provider's small-model default. */
  model: string | null;
}

export interface AppSettings {
  titleGeneration: TitleGenerationSettings;
  /**
   * Extra model slugs to offer for a provider, for models the CLI knows about
   * but does not advertise. Keyed by agent id.
   */
  customModels: Record<string, string[]>;
  /** Show the agent's reasoning in the transcript rather than folding it away. */
  showThinking: boolean;
  /** Jump to the Output tab the first time a runtime error appears. */
  followRuntimeErrors: boolean;
}

/** Small, fast models — a title is not worth a frontier model's time. */
export const DEFAULT_TITLE_MODEL: Record<AgentId, string> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5.4-mini",
};

export const DEFAULT_SETTINGS: AppSettings = {
  titleGeneration: { enabled: true, provider: "auto", model: null },
  customModels: {},
  showThinking: true,
  followRuntimeErrors: true,
};

/**
 * Fills in anything a stored file is missing.
 *
 * Settings files outlive the build that wrote them, so a missing key means "an
 * older version", not "corrupt" — the defaults fill the gap rather than the
 * whole file being thrown away.
 */
export function withDefaults(stored: unknown): AppSettings {
  const value = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<AppSettings>;
  const title: Partial<TitleGenerationSettings> = value.titleGeneration ?? {};

  return {
    titleGeneration: {
      enabled: title.enabled ?? DEFAULT_SETTINGS.titleGeneration.enabled,
      provider: title.provider ?? DEFAULT_SETTINGS.titleGeneration.provider,
      model: title.model ?? DEFAULT_SETTINGS.titleGeneration.model,
    },
    customModels: value.customModels ?? {},
    showThinking: value.showThinking ?? DEFAULT_SETTINGS.showThinking,
    followRuntimeErrors: value.followRuntimeErrors ?? DEFAULT_SETTINGS.followRuntimeErrors,
  };
}
