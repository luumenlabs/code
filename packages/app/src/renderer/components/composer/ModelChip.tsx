/**
 * The model control: the model, the CLI behind it, and everything set on it.
 * There is no separate CLI picker — the model implies the provider.
 *
 * Two columns: the models on the left, the settings for the selected one on the
 * right. Picking a model does not close the popover. A star saves the model and
 * the settings it is on, so "Opus 5 on Max" and "Opus 5 on Low" are two
 * favourites. The list comes from the CLIs themselves.
 */
import * as React from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
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
import { lockedProvider } from "../../../shared/threads.js";
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

  /**
   * The provider this conversation started on, once it has started. Another
   * provider's models are shown and disabled rather than hidden.
   */
  const locked = lockedProvider(harness.threads, harness.activeThreadId);
  const blocked = React.useCallback(
    (provider: AgentId): boolean => locked !== null && locked !== provider,
    [locked],
  );

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

  /**
   * Which rail is open. Null until the user picks one, and until then the
   * picker opens on the provider in use. Component state, not settings: this is
   * where you were a moment ago, not a preference.
   */
  const [chosenRail, setChosenRail] = React.useState<Rail | null>(null);

  const fallbackRail: Rail = active?.provider ?? providers[0] ?? "claude";

  // A remembered rail the open chat cannot use has every model greyed out, so
  // it is not somewhere to land. Favourites are filtered, never blocked.
  const rail: Rail =
    chosenRail === null || (chosenRail !== "favorites" && blocked(chosenRail)) ? fallbackRail : chosenRail;

  const setRail = setChosenRail;

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

  /**
   * Favourites this chat can actually use. A locked chat keeps its own
   * provider's stars; the rest are left out rather than listed and refused,
   * including any whose model is no longer in the catalogue.
   */
  const visibleFavourites = React.useMemo(() => {
    if (!locked) return favourites;
    return favourites.filter((favourite) => models.find((model) => model.slug === favourite.model)?.provider === locked);
  }, [favourites, locked, models]);

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

  const choose = React.useCallback(
    (model: ModelInfo) => {
      if (blocked(model.provider)) return;

      // Selecting the model selects the CLI behind it, on that model's
      // defaults. The picker stays open for the settings beside it.
      apply(createSelection(model.provider, model.slug));
    },
    [apply, blocked],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.shiftKey) return;

      const index = Number.parseInt(event.key, 10) - 1;
      if (!Number.isInteger(index)) return;

      // Ctrl+N is the Nth thing in front of you, which on this rail is a star.
      if (showingFavourites) {
        const favourite = visibleFavourites[index];
        if (!favourite) return;

        event.preventDefault();
        apply({ model: favourite.model, options: favourite.options });
        setOpen(false);
        return;
      }

      const model = current[index];
      if (!model || blocked(model.provider)) return;

      // A shortcut is someone who knows what they want, so this one closes.
      event.preventDefault();
      choose(model);
      setOpen(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, blocked, choose, current, showingFavourites, visibleFavourites]);

  /**
   * Stars the whole setup, or removes the one it matches. The options are
   * written out in full, so a favourite means the same thing after a model's
   * own default moves underneath it.
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

  /** Said the same way wherever a locked-out thing is hovered. */
  const LOCKED_LABEL = "Start a new chat to switch providers";
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
          "flex h-7 max-w-[300px] items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors outline-none",
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

      <PopoverContent align="start" side="top" collisionPadding={12} className="w-[524px] overflow-hidden p-0">
        <div className="flex items-stretch">
          {!searching && (
            <div className="flex w-12 shrink-0 flex-col gap-1 border-r bg-muted/30 p-1">
              <RailButton label="Favourites" active={rail === "favorites"} onClick={() => setRail("favorites")}>
                <Star className={cn("size-4", visibleFavourites.length > 0 && "fill-current")} />
              </RailButton>

              <div className="mx-1 border-b" aria-hidden />

              {providers.map((provider) => {
                const agent = agentFor(provider);
                const missing = agent !== undefined && !agent.installed;
                const shut = blocked(provider);

                const label = shut ? LOCKED_LABEL : missing ? `${agent?.label} is not installed` : PROVIDER_LABEL[provider];

                return (
                  <Hint key={provider} label={label}>
                    <RailButton
                      label={PROVIDER_LABEL[provider]}
                      active={rail === provider}
                      dimmed={missing || shut}
                      shut={shut}
                      onClick={() => {
                        if (shut) return;
                        setRail(provider);
                      }}
                    >
                      <ProviderIcon provider={provider} className="size-4.5" />
                    </RailButton>
                  </Hint>
                );
              })}
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col border-r">
            <div className="relative h-10 shrink-0 border-b">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models…"
                spellCheck={false}
                className="h-full w-full bg-transparent pr-2 pl-8 text-[13.5px] outline-none placeholder:text-muted-foreground"
                style={{ userSelect: "text", cursor: "auto" }}
              />
            </div>

            <div className="max-h-[300px] min-h-[180px] overflow-y-auto p-1">
              {showingFavourites &&
                visibleFavourites.map((favourite) => (
                  <FavouriteRow
                    key={favourite.id}
                    favourite={favourite}
                    model={models.find((entry) => entry.slug === favourite.model)}
                    active={selectionKey(favourite) === currentKey}
                    onChoose={() => apply({ model: favourite.model, options: favourite.options })}
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
                    blockedReason={blocked(model.provider) ? LOCKED_LABEL : null}
                    onChoose={() => choose(model)}
                  />
                ))}

              {showingFavourites && visibleFavourites.length === 0 && (
                <p className="px-2 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
                  {locked && favourites.length > 0
                    ? "No favourites for this provider."
                    : "No favourites yet. Star a model to save it with its settings."}
                </p>
              )}

              {!showingFavourites && current.length === 0 && legacy.length === 0 && (
                <p className="px-2 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
                  {models.length === 0 ? "Looking for models…" : "No models match."}
                </p>
              )}

              {!searching && !showingFavourites && legacy.length > 0 && (
                <button
                  onClick={() => setShowLegacy((value) => !value)}
                  className="row mt-1 flex w-full items-center gap-2 px-2 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">Legacy models</span>
                    <span className="block text-[11.5px] text-muted-foreground">{legacy.length} models</span>
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
                    blockedReason={blocked(model.provider) ? LOCKED_LABEL : null}
                    onChoose={() => choose(model)}
                  />
                ))}
            </div>

            {/* Said once, rather than inferred from a list that will not click. */}
            {locked && (
              <p className="border-t px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {LOCKED_LABEL}
              </p>
            )}

            {harness.modelProblem && (
              <p className="border-t px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Could not read Codex models: {harness.modelProblem}
              </p>
            )}
          </div>

          <Setup
            model={info}
            selection={selection}
            starred={starred !== null}
            onChange={apply}
            onToggleStar={toggleStar}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The right-hand column: what the selected model is set to. */
function Setup({
  model,
  selection,
  starred,
  onChange,
  onToggleStar,
}: {
  model: ModelInfo | undefined;
  selection: ModelSelection | null;
  starred: boolean;
  onChange: (selection: ModelSelection) => void;
  onToggleStar: () => void;
}): React.JSX.Element {
  return (
    <div className="flex w-[228px] shrink-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {model?.name ?? "No model selected"}
        </span>

        {model && selection && (
          <Hint label={starred ? "Remove from favourites" : "Save with these settings"}>
            <button
              aria-label={starred ? "Remove from favourites" : "Save with these settings"}
              onClick={onToggleStar}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Star className={cn("size-3.5", starred && "fill-[var(--warning)] text-[var(--warning)]")} />
            </button>
          </Hint>
        )}
      </div>

      <div className="max-h-[300px] flex-1 overflow-y-auto p-1">
        {!model || !selection ? (
          <p className="px-2 py-2 text-[12.5px] leading-relaxed text-muted-foreground">Pick a model.</p>
        ) : model.options.length === 0 ? (
          <p className="px-2 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
            Nothing to adjust on this one.
          </p>
        ) : (
          model.options.map((descriptor, index) => (
            <Option
              key={descriptor.id}
              descriptor={descriptor}
              selection={selection}
              first={index === 0}
              onChange={onChange}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Option({
  descriptor,
  selection,
  first,
  onChange,
}: {
  descriptor: OptionDescriptor;
  selection: ModelSelection;
  first: boolean;
  onChange: (selection: ModelSelection) => void;
}): React.JSX.Element {
  const value = effectiveOption(selection, descriptor);

  // A yes-or-no setting is a switch, not two rows to pick between.
  if (descriptor.kind === "boolean") {
    return (
      <div className={cn("flex items-center gap-2 px-2 py-1.5", !first && "mt-1 border-t pt-2.5")}>
        <span className="min-w-0 flex-1 truncate text-[13px]">{descriptor.label}</span>
        <Switch
          checked={value === true}
          onCheckedChange={(next) => onChange(withOption(selection, descriptor.id, next))}
        />
      </div>
    );
  }

  return (
    <div className={cn(!first && "mt-1 border-t pt-1")}>
      <div className="px-2 py-1 text-[11.5px] font-medium text-muted-foreground">{descriptor.label}</div>

      {descriptor.choices.map((choice) => {
        const active = value === choice.value;

        return (
          <button
            key={choice.value}
            onClick={() => onChange(withOption(selection, descriptor.id, choice.value))}
            data-active={active}
            className="row flex w-full items-center gap-2 px-2 py-1 text-left text-[13px]"
          >
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
            {choice.isDefault && !active && <span className="shrink-0 text-[11px] text-muted-foreground">Default</span>}
            {active && <Check className="size-3 shrink-0 text-primary" />}
          </button>
        );
      })}
    </div>
  );
}

function RailButton({
  label,
  active,
  dimmed,
  shut,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  dimmed?: boolean;
  /** Locked out of this chat: it stays visible, and it does not open. */
  shut?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      aria-disabled={shut}
      onClick={onClick}
      className={cn(
        "relative grid aspect-square w-full place-items-center rounded-md transition-colors",
        // Not `disabled`: the browser would swallow the hover the tooltip needs.
        shut ? "cursor-not-allowed" : "hover:bg-accent",
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
        <span className="block truncate text-[13.5px] font-medium">{model?.name ?? favourite.model}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
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
  blockedReason,
  onChoose,
}: {
  model: ModelInfo;
  index: number;
  active: boolean;
  agent: AgentInfo | undefined;
  /** Why this cannot be picked from the open chat, or null when it can. */
  blockedReason: string | null;
  onChoose: () => void;
}): React.JSX.Element {
  const missing = agent !== undefined && !agent.installed;
  const shut = blockedReason !== null;

  const row = (
    <button
      onClick={onChoose}
      data-active={active}
      aria-disabled={shut}
      className={cn(
        "row flex w-full items-center gap-2 px-2 py-1.5 text-left",
        missing && "opacity-55",
        shut && "cursor-not-allowed opacity-45",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{model.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {missing ? <CircleAlert className="size-3 shrink-0" /> : <ProviderIcon provider={model.provider} className="size-3 shrink-0" />}
          {PROVIDER_LABEL[model.provider]}
          {missing && " — not installed"}
        </span>
      </span>

      {active && <Check className="size-3 shrink-0 text-primary" />}

      {/* No shortcut is advertised for a row that will not take one. */}
      {!active && !shut && index >= 0 && index < 9 && (
        <kbd className="shrink-0 rounded border px-1 py-px font-mono text-[10.5px] text-muted-foreground">
          Ctrl+{index + 1}
        </kbd>
      )}
    </button>
  );

  // The lock is why the click did nothing, so it outranks the rest.
  if (shut) return <Hint label={blockedReason}>{row}</Hint>;
  if (missing) return <Hint label={`${agent?.label} is not installed. ${agent?.installHint ?? ""}`}>{row}</Hint>;
  if (model.description) return <Hint label={model.description}>{row}</Hint>;

  return row;
}
