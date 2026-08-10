/**
 * User settings.
 *
 * Deliberately small. Every entry here is something a user has a real reason to
 * change — not a knob added because it was easy. Anything that can be inferred
 * from the connected place or the installed CLIs is inferred instead of asked.
 */
import type { AgentId } from "./agent.js";
import type { ModelSelection, OptionValue } from "./models.js";

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

/**
 * A starred model *and* the settings it was starred with.
 *
 * The same model at Low reasoning and at Max is two different tools in
 * practice, so a favourite carries the whole selection and the same model can
 * be starred more than once. The id is what lets it: two favourites can share a
 * slug and still be told apart.
 */
export interface FavouriteSelection extends ModelSelection {
  id: string;
}

export interface AppSettings {
  titleGeneration: TitleGenerationSettings;
  /**
   * Extra model slugs to offer for a provider, for models the CLI knows about
   * but does not advertise. Keyed by agent id.
   */
  customModels: Record<string, string[]>;
  /** Starred model-and-options combinations, in the order they were starred. */
  favourites: FavouriteSelection[];
  /** Show the agent's reasoning in the transcript rather than folding it away. */
  showThinking: boolean;
  /** Jump to the Output tab the first time a runtime error appears. */
  followRuntimeErrors: boolean;
}

/** Small, fast models — a title is not worth a frontier model's time. */
export const DEFAULT_TITLE_MODEL: Record<AgentId, string> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5.6-luna",
};

/**
 * Who names threads when the user has not said.
 *
 * Codex first: GPT-5.6-Luna is the cheapest of the small models to run for a
 * one-line answer and it comes back fastest, so it gets the job whenever Codex
 * is installed. Claude Code's Haiku takes over when it is not.
 */
export const TITLE_PROVIDER_ORDER: AgentId[] = ["codex", "claude"];

/** The CLI that names threads on this machine, given what is installed. */
export function autoTitleProvider(installed: AgentId[]): AgentId | null {
  return TITLE_PROVIDER_ORDER.find((id) => installed.includes(id)) ?? null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  titleGeneration: { enabled: true, provider: "auto", model: null },
  customModels: {},
  favourites: [],
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
    favourites: readFavourites(stored),
    showThinking: value.showThinking ?? DEFAULT_SETTINGS.showThinking,
    followRuntimeErrors: value.followRuntimeErrors ?? DEFAULT_SETTINGS.followRuntimeErrors,
  };
}

/**
 * Favourites, including the ones written before they carried options.
 *
 * The old shape was a list of slugs. Those become favourites with no options
 * recorded, which resolves to the model's own defaults — the same thing the
 * star used to mean.
 */
function readFavourites(stored: unknown): FavouriteSelection[] {
  const value = (typeof stored === "object" && stored !== null ? stored : {}) as {
    favourites?: unknown;
    favouriteModels?: unknown;
  };

  if (Array.isArray(value.favourites)) {
    return value.favourites.flatMap((entry) => {
      const favourite = entry as Partial<FavouriteSelection>;
      if (typeof favourite?.model !== "string" || favourite.model.length === 0) return [];

      return [
        {
          id: typeof favourite.id === "string" && favourite.id.length > 0 ? favourite.id : `f_${favourite.model}`,
          model: favourite.model,
          options: Array.isArray(favourite.options)
            ? favourite.options.filter(
                (option): option is { id: string; value: OptionValue } =>
                  typeof option?.id === "string" &&
                  (typeof option.value === "string" || typeof option.value === "boolean"),
              )
            : [],
        },
      ];
    });
  }

  if (Array.isArray(value.favouriteModels)) {
    return value.favouriteModels
      .filter((slug): slug is string => typeof slug === "string")
      .map((slug) => ({ id: `f_${slug}`, model: slug, options: [] }));
  }

  return [];
}
