/**
 * The model control: the model, the CLI behind it, and everything set on it.
 *
 * There is no separate CLI picker: the model implies the provider. Choosing a
 * GPT model is choosing Codex, choosing a Claude model is choosing Claude Code.
 * Asking for both was asking the same question twice — and so was splitting the
 * model off from its reasoning level, which is the same decision made twice.
 * Picking the model and dialling it in happen in one place.
 *
 * The list is filtered by a provider rail rather than shown all at once —
 * fifteen models across two vendors is a wall of text, and the user almost
 * always knows which vendor they want before they know which model. Searching
 * drops the rail, because a search is a question about everything.
 *
 * A star saves the model *and* the settings it is on, so "Opus 5 on Max" and
 * "Opus 5 on Low" are two favourites rather than one, and picking either is a
 * single click.
 *
 * What is in the list comes from the CLIs themselves, so a model released after
 * this build still shows up.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, CircleAlert, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Hint } from "@/components/ui/tooltip";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import {
  createSelection,
  describeOptions,
  effectiveOption,
  findModel,
  normalizeSelection,
  selectionKey,
  withOption,
} from "../../../shared/models.js";
import type { ModelInfo, ModelSelection, OptionDescriptor } from "../../../shared/models.js";
import type { FavouriteSelection } from "../../../shared/settings.js";
import type { AgentId, AgentInfo } from "../../../shared/agent.js";
import type { Harness } from "@/state";

type Rail = AgentId | "favorites";

export function ModelChip({ harness }: { harness: Harness }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showLegacy, setShowLegacy] = React.useState(false);
  const search = React.useRef<HTMLInputElement>(null);

  const snapshot = harness.snapshot;
  const selection = harness.modelSelection;
  const models = harness.models;
  const active = models.find((model) => model.slug === selection?.model);

  // Stars live in settings, so they survive a restart like any other preference.
  const favourites = harness.settings.favourites;

  // The star is filled only when the current model *and* its current settings
  // are the ones that were saved.
  const currentKey = selectionKey(selection);
  const starred = favourites.find((favourite) => selectionKey(favourite) === currentKey) ?? null;

  // One rail entry per provider that actually has models, in catalogue order.
  const providers = React.useMemo(() => {
    const seen: AgentId[] = [];
    for (const model of models) if (!seen.includes(model.provider)) seen.push(model.provider);
    return seen;
  }, [models]);

  const [rail, setRail] = React.useState<Rail>("claude");

  // Read through a ref so starring a setup does not re-run this: the star is a
  // bookmark, not a navigation, and yanking the list out from under the click
  // loses the user's place.
  const railDefaults = React.useRef({ hasFavourites: false, provider: undefined as Rail | undefined });
  railDefaults.current = {
    hasFavourites: favourites.length > 0,
    provider: active?.provider ?? providers[0],
  };

  // Open where the user left off rather than on whichever provider sorts first.
  React.useEffect(() => {
    if (!open) return;
    const { hasFavourites, provider } = railDefaults.current;
    setRail(hasFavourites ? "favorites" : (provider ?? "claude"));
  }, [open]);

  const searching = query.trim().length > 0;

  const matches = React.useCallback(
    (model: ModelInfo): boolean => {
      const needle = query.trim().toLowerCase();
      return (
        model.name.toLowerCase().includes(needle) ||
        model.slug.toLowerCase().includes(needle) ||
        PROVIDER_LABEL[model.provider].toLowerCase().includes(needle)
      );
    },
    [query],
  );

  const showingFavourites = rail === "favorites" && !searching;

  const visible = React.useMemo(() => {
    // Searching spans every provider: the rail is a filter, not a scope.
    if (searching) return models.filter(matches);
    if (rail === "favorites") return [];
    return models.filter((model) => model.provider === rail);
  }, [matches, models, rail, searching]);

  const current = visible.filter((model) => !model.legacy);
  const legacy = visible.filter((model) => model.legacy);

  const apply = React.useCallback(
    (next: ModelSelection) => {
      harness.applyModel(next);
    },
    [harness],
  );

  /** Picking anything from the list is a decision; tuning options is not. */
  const commit = React.useCallback(
    (next: ModelSelection) => {
      apply(next);
      setOpen(false);
      setQuery("");
    },
    [apply],
  );

  const choose = React.useCallback(
    (model: ModelInfo) => {
      // Selecting the model selects the CLI behind it, on that model's defaults.
      commit(createSelection(model.provider, model.slug));
    },
    [commit],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.shiftKey) return;

      const index = Number.parseInt(event.key, 10) - 1;
      const model = current[index];
      if (!Number.isInteger(index) || !model) return;

      event.preventDefault();
      choose(model);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, current]);

  /**
   * Stars the whole setup, or removes the one it matches.
   *
   * The options are written out in full rather than as "whatever the user
   * touched", so a favourite still means the same thing after a model's own
   * default reasoning level changes underneath it.
   */
  const toggleStar = (): void => {
    if (!selection) return;

    harness.updateSettings({
      favourites: starred
        ? favourites.filter((favourite) => favourite.id !== starred.id)
        : [
            ...favourites,
            { id: `f_${Math.random().toString(36).slice(2, 10)}`, ...normalizeSelection(selection) },
          ],
    });
  };

  const removeStar = (id: string, event: React.MouseEvent): void => {
    event.stopPropagation();
    harness.updateSettings({ favourites: favourites.filter((favourite) => favourite.id !== id) });
  };

  if (!snapshot) return null;

  const agentFor = (provider: AgentId): AgentInfo | undefined =>
    snapshot.agents.find((agent) => agent.id === provider);

  const activeAgent = active ? agentFor(active.provider) : undefined;
  const unavailable = active !== undefined && activeAgent !== undefined && !activeAgent.installed;
  const summary = describeOptions(selection);
  const info = findModel(selection?.model);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) requestAnimationFrame(() => search.current?.focus());
        else setQuery("");
      }}
    >
      <PopoverTrigger
        className={cn(
          "flex h-6 max-w-[280px] items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors outline-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60",
          unavailable ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {unavailable ? (
          <CircleAlert className="size-3.5 shrink-0" />
        ) : active ? (
          <ProviderIcon provider={active.provider} className="size-3 shrink-0" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        )}

        <span className="truncate">{active?.name ?? (models.length === 0 ? "Looking for models…" : "Choose a model")}</span>
        {summary && <span className="truncate opacity-60">{summary}</span>}

        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[360px] overflow-hidden p-0">
        <div className="flex">
          {!searching && (
            <div className="flex w-11 shrink-0 flex-col gap-1 border-r bg-muted/30 p-1">
              <RailButton label="Favourites" active={rail === "favorites"} onClick={() => setRail("favorites")}>
                <Star className={cn("size-4", favourites.length > 0 && "fill-current")} />
              </RailButton>

              <div className="mx-1 border-b" aria-hidden />

              {providers.map((provider) => {
                const agent = agentFor(provider);
                const missing = agent !== undefined && !agent.installed;

                return (
                  <Hint key={provider} label={missing ? `${agent?.label} is not installed` : PROVIDER_LABEL[provider]}>
                    <RailButton
                      label={PROVIDER_LABEL[provider]}
                      active={rail === provider}
                      dimmed={missing}
                      onClick={() => setRail(provider)}
                    >
                      <ProviderIcon provider={provider} className="size-4.5" />
                    </RailButton>
                  </Hint>
                );
              })}
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative border-b">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models…"
                spellCheck={false}
                className="h-9 w-full bg-transparent pr-2 pl-8 text-[12.5px] outline-none placeholder:text-muted-foreground"
                style={{ userSelect: "text", cursor: "auto" }}
              />
            </div>

            <div className="max-h-[260px] overflow-y-auto p-1">
              {showingFavourites &&
                favourites.map((favourite) => (
                  <FavouriteRow
                    key={favourite.id}
                    favourite={favourite}
                    model={models.find((model) => model.slug === favourite.model)}
                    active={selectionKey(favourite) === currentKey}
                    onChoose={() => commit({ model: favourite.model, options: favourite.options })}
                    onRemove={(event) => removeStar(favourite.id, event)}
                  />
                ))}

              {!showingFavourites &&
                current.map((model, index) => (
                  <ModelRow
                    key={model.slug}
                    model={model}
                    index={searching ? -1 : index}
                    active={selection?.model === model.slug}
                    agent={agentFor(model.provider)}
                    onChoose={() => choose(model)}
                  />
                ))}

              {showingFavourites && favourites.length === 0 && (
                <p className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  No favourites yet. Set a model up the way you like it and star it below — the settings are saved with
                  it.
                </p>
              )}

              {!showingFavourites && current.length === 0 && legacy.length === 0 && (
                <p className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  {models.length === 0 ? "Looking for installed CLIs…" : "No models match."}
                </p>
              )}

              {!searching && !showingFavourites && legacy.length > 0 && (
                <button
                  onClick={() => setShowLegacy((value) => !value)}
                  className="row mt-1 flex w-full items-center gap-2 px-2 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium">Legacy models</span>
                    <span className="block text-[10.5px] text-muted-foreground">{legacy.length} models</span>
                  </span>
                  <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", showLegacy && "rotate-90")} />
                </button>
              )}

              {(showLegacy || searching) &&
                !showingFavourites &&
                legacy.map((model) => (
                  <ModelRow
                    key={model.slug}
                    model={model}
                    index={-1}
                    active={selection?.model === model.slug}
                    agent={agentFor(model.provider)}
                    onChoose={() => choose(model)}
                  />
                ))}
            </div>

            {info && selection && (
              <Setup
                model={info}
                selection={selection}
                starred={starred !== null}
                onChange={apply}
                onToggleStar={toggleStar}
              />
            )}

            {harness.modelProblem && (
              <p className="border-t px-2.5 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                Codex models could not be read: {harness.modelProblem}
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The settings for whatever is selected, under the list rather than behind a
 * second chip. Changing one applies immediately and leaves the popover open:
 * dialling in reasoning is a series of small adjustments, not a decision.
 */
function Setup({
  model,
  selection,
  starred,
  onChange,
  onToggleStar,
}: {
  model: ModelInfo;
  selection: ModelSelection;
  starred: boolean;
  onChange: (selection: ModelSelection) => void;
  onToggleStar: () => void;
}): React.JSX.Element {
  return (
    <div className="border-t bg-muted/20">
      <div className="flex items-center gap-1.5 px-2.5 pt-2">
        <span className="eyebrow min-w-0 flex-1 truncate">{model.name}</span>

        <Hint label={starred ? "Remove this setup from favourites" : "Star this model with these settings"}>
          <button
            onClick={onToggleStar}
            className="row flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            <Star className={cn("size-3.5", starred && "fill-[var(--warning)] text-[var(--warning)]")} />
            {starred ? "Starred" : "Star setup"}
          </button>
        </Hint>
      </div>

      {model.options.length === 0 ? (
        <p className="px-2.5 pt-1 pb-2.5 text-[11px] text-muted-foreground">Nothing to adjust on this one.</p>
      ) : (
        <div className="max-h-[180px] overflow-y-auto px-2.5 pt-1 pb-2.5">
          {model.options.map((descriptor) => (
            <Option key={descriptor.id} descriptor={descriptor} selection={selection} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every choice is visible rather than hidden behind a second menu — a nested
 * dropdown inside a dropdown is two clicks to see what one glance can show.
 */
function Option({
  descriptor,
  selection,
  onChange,
}: {
  descriptor: OptionDescriptor;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
}): React.JSX.Element {
  const value = effectiveOption(selection, descriptor);

  const choices =
    descriptor.kind === "select"
      ? descriptor.choices.map((choice) => ({ key: choice.value, label: choice.label, value: choice.value as string | boolean }))
      : [
          { key: "off", label: "Off", value: false },
          { key: "on", label: "On", value: true },
        ];

  return (
    <div className="mt-1.5 first:mt-0">
      <div className="text-[10.5px] text-muted-foreground">{descriptor.label}</div>

      <div className="mt-1 flex flex-wrap gap-1">
        {choices.map((choice) => {
          const active = value === choice.value;

          return (
            <button
              key={choice.key}
              onClick={() => onChange(withOption(selection, descriptor.id, choice.value))}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                active
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RailButton({
  label,
  active,
  dimmed,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative grid aspect-square w-full place-items-center rounded-md transition-colors hover:bg-accent",
        dimmed && "opacity-45",
      )}
    >
      {children}
      {active && (
        <span className="pointer-events-none absolute top-1/2 -right-1 h-5 w-[3px] -translate-y-1/2 rounded-l-full bg-primary" />
      )}
    </button>
  );
}

/** A starred setup: the model, and the settings it was starred on. */
function FavouriteRow({
  favourite,
  model,
  active,
  onChoose,
  onRemove,
}: {
  favourite: FavouriteSelection;
  model: ModelInfo | undefined;
  active: boolean;
  onChoose: () => void;
  onRemove: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const summary = describeOptions(favourite);

  return (
    <button
      onClick={onChoose}
      data-active={active}
      className="row flex w-full items-center gap-2 px-2 py-1.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{model?.name ?? favourite.model}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] text-muted-foreground">
          {model && <ProviderIcon provider={model.provider} className="size-3 shrink-0" />}
          {summary || "Default settings"}
        </span>
      </span>

      <span
        role="button"
        tabIndex={-1}
        aria-label="Remove from favourites"
        onClick={onRemove}
        className="shrink-0 text-[var(--warning)] transition-opacity hover:opacity-60"
      >
        <Star className="size-3.5 fill-[var(--warning)]" />
      </span>
    </button>
  );
}

function ModelRow({
  model,
  index,
  active,
  agent,
  onChoose,
}: {
  model: ModelInfo;
  index: number;
  active: boolean;
  agent: AgentInfo | undefined;
  onChoose: () => void;
}): React.JSX.Element {
  const missing = agent !== undefined && !agent.installed;

  const row = (
    <button
      onClick={onChoose}
      data-active={active}
      className={cn("row flex w-full items-center gap-2 px-2 py-1.5 text-left", missing && "opacity-55")}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{model.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          {missing ? <CircleAlert className="size-3 shrink-0" /> : <ProviderIcon provider={model.provider} className="size-3 shrink-0" />}
          {PROVIDER_LABEL[model.provider]}
          {missing && " — not installed"}
        </span>
      </span>

      {index >= 0 && index < 9 && (
        <kbd className="shrink-0 rounded border px-1 py-px font-mono text-[9.5px] text-muted-foreground">
          Ctrl+{index + 1}
        </kbd>
      )}
    </button>
  );

  if (missing) return <Hint label={`${agent?.label} is not installed. ${agent?.installHint ?? ""}`}>{row}</Hint>;
  if (model.description) return <Hint label={model.description}>{row}</Hint>;

  return row;
}
