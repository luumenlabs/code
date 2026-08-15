/**
 * User settings. Anything that can be inferred from the connected place or the
 * installed CLIs is inferred rather than asked.
 */
import type { AgentId } from "./agent.js";
import type { ModelSelection, OptionValue } from "./models.js";

export interface TitleGenerationSettings {
  /** Titles cost one cheap model call per conversation. */
  enabled: boolean;
  /** Which CLI runs the call. Falls back to whichever one is installed. */
  provider: AgentId | "auto";
  /** Model slug, or null to use the provider's small-model default. */
  model: string | null;
}

/**
 * A starred model and the options it was starred with. The same model can be
 * starred more than once; the id is what tells two favourites on one slug apart.
 */
export interface FavouriteSelection extends ModelSelection {
  id: string;
}

export interface PluginSettings {
  /**
   * Keep the Studio plugin matching the app. Off until the user says
   * otherwise — this writes outside the app's own storage.
   */
  autoInstall: boolean;
}

export interface AppSettings {
  titleGeneration: TitleGenerationSettings;
  plugin: PluginSettings;
  /**
   * Extra model slugs to offer for a provider, for models the CLI knows about
   * but does not advertise. Keyed by agent id.
   */
  customModels: Record<string, string[]>;
  /** Starred model-and-options combinations, in the order they were starred. */
  favourites: FavouriteSelection[];
  /**
   * Rules given to every agent, in every place, before the place's own. These
   * follow the user; a place's rules live at TestService.AGENTS.
   */
  globalRules: string;
  /** Show the agent's reasoning in the transcript rather than folding it away. */
  showThinking: boolean;
  /** Jump to the Output tab the first time a runtime error appears. */
  followRuntimeErrors: boolean;
  /** How wide the user has dragged each panel. Survives a restart. */
  layout: LayoutSettings;
}

export interface LayoutSettings {
  sidebarWidth: number;
  dockWidth: number;
}

/** What a panel can be dragged between, in pixels. */
export const PANEL_BOUNDS = {
  sidebar: { min: 200, max: 520 },
  dock: { min: 260, max: 900 },
} as const;

export function clampPanel(width: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(width)) return bounds.min;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

/** The narrowest the conversation is allowed to get before the panels give way. */
export const MIN_TRANSCRIPT = 420;

/**
 * The widths the panels actually get, given the window they are in. A stored
 * width is a maximum, honoured when there is room. The dock gives first, then
 * the sidebar, and only then does the transcript lose width.
 */
export function fitPanels(input: {
  /** Width of the row holding all three. Zero before it has been measured. */
  available: number;
  sidebar: number;
  /** Zero when the dock is closed. */
  dock: number;
}): { sidebar: number; dock: number } {
  const { available } = input;
  let sidebar = input.sidebar;
  let dock = input.dock;

  // Not measured yet. Guessing would make the first paint jump.
  if (available <= 0) return { sidebar, dock };

  let overflow = sidebar + dock + MIN_TRANSCRIPT - available;
  if (overflow <= 0) return { sidebar, dock };

  const dockGive = Math.min(overflow, Math.max(0, dock - PANEL_BOUNDS.dock.min));
  dock -= dockGive;
  overflow -= dockGive;

  const sidebarGive = Math.min(overflow, Math.max(0, sidebar - PANEL_BOUNDS.sidebar.min));
  sidebar -= sidebarGive;
  overflow -= sidebarGive;

  if (overflow <= 0) return { sidebar: Math.round(sidebar), dock: Math.round(dock) };

  // Below every minimum at once. Both shrink together, down to a strip still
  // wide enough to grab.
  const floor = 120;
  const room = Math.max(0, available - MIN_TRANSCRIPT);
  const total = sidebar + dock;
  const scale = total > 0 ? Math.max(0, room) / total : 0;

  return {
    sidebar: Math.round(Math.max(sidebar > 0 ? floor : 0, sidebar * scale)),
    dock: Math.round(Math.max(dock > 0 ? floor : 0, dock * scale)),
  };
}

/**
 * Small, fast models for naming a thread. Ollama has no entry — its default
 * comes from the discovered catalogue, since the slugs are whatever was pulled.
 */
export const DEFAULT_TITLE_MODEL: Partial<Record<AgentId, string>> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5.6-luna",
};

/** Who names threads when the user has not said. First installed wins. */
export const TITLE_PROVIDER_ORDER: AgentId[] = ["codex", "claude", "ollama"];

/** The CLI that names threads on this machine, given what is installed. */
export function autoTitleProvider(installed: AgentId[]): AgentId | null {
  return TITLE_PROVIDER_ORDER.find((id) => installed.includes(id)) ?? null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  titleGeneration: { enabled: true, provider: "auto", model: null },
  plugin: { autoInstall: false },
  customModels: {},
  favourites: [],
  globalRules: "",
  showThinking: true,
  followRuntimeErrors: true,
  // The values the CSS variables carried before either panel could be dragged.
  layout: { sidebarWidth: 276, dockWidth: 340 },
};

/**
 * Fills in anything a stored file is missing. Settings files outlive the build
 * that wrote them, so a missing key is an older version, not a corrupt file.
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
    plugin: { autoInstall: value.plugin?.autoInstall ?? DEFAULT_SETTINGS.plugin.autoInstall },
    customModels: value.customModels ?? {},
    favourites: readFavourites(stored),
    globalRules: typeof value.globalRules === "string" ? value.globalRules : DEFAULT_SETTINGS.globalRules,
    showThinking: value.showThinking ?? DEFAULT_SETTINGS.showThinking,
    followRuntimeErrors: value.followRuntimeErrors ?? DEFAULT_SETTINGS.followRuntimeErrors,
    layout: {
      // Clamped in as well as out: a width stored on a larger monitor must not
      // open a panel wider than this window.
      sidebarWidth: clampPanel(value.layout?.sidebarWidth ?? DEFAULT_SETTINGS.layout.sidebarWidth, PANEL_BOUNDS.sidebar),
      dockWidth: clampPanel(value.layout?.dockWidth ?? DEFAULT_SETTINGS.layout.dockWidth, PANEL_BOUNDS.dock),
    },
  };
}

/**
 * Favourites, including the ones written before they carried options. The old
 * shape was a list of slugs; those resolve to the model's own defaults.
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
