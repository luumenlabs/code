/**
 * Model picker.
 *
 * There is no separate CLI picker: the model implies the provider. Choosing a
 * GPT model is choosing Codex, choosing a Claude model is choosing Claude Code.
 * Asking for both was asking the same question twice.
 *
 * The list is filtered by a provider rail rather than shown all at once —
 * fifteen models across two vendors is a wall of text, and the user almost
 * always knows which vendor they want before they know which model. Searching
 * drops the rail, because a search is a question about everything.
 *
 * What is in the list comes from the CLIs themselves, so a model released after
 * this build still shows up.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, CircleAlert, Loader2, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Hint } from "@/components/ui/tooltip";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "../../../shared/models.js";
import type { AgentId, AgentInfo } from "../../../shared/agent.js";
import type { Harness } from "@/state";

type Rail = AgentId | "favorites";

export function ModelChip({ harness }: { harness: Harness }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showLegacy, setShowLegacy] = React.useState(false);
  const [favourites, setFavourites] = React.useState<Set<string>>(new Set());
  const search = React.useRef<HTMLInputElement>(null);

  const snapshot = harness.snapshot;
  const selection = harness.modelSelection;
  const models = harness.models;
  const active = models.find((model) => model.slug === selection?.model);
  const state = snapshot?.session.state;
  const busy = state === "thinking" || state === "working" || state === "starting";

  // One rail entry per provider that actually has models, in catalogue order.
  const providers = React.useMemo(() => {
    const seen: AgentId[] = [];
    for (const model of models) if (!seen.includes(model.provider)) seen.push(model.provider);
    return seen;
  }, [models]);

  const [rail, setRail] = React.useState<Rail>("claude");

  // Read through a ref so starring a model does not re-run this: the star is a
  // bookmark, not a navigation, and yanking the list out from under the click
  // loses the user's place.
  const railDefaults = React.useRef({ hasFavourites: false, provider: undefined as Rail | undefined });
  railDefaults.current = {
    hasFavourites: favourites.size > 0,
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

  const visible = React.useMemo(() => {
    // Searching spans every provider: the rail is a filter, not a scope.
    if (searching) return models.filter(matches);
    if (rail === "favorites") return models.filter((model) => favourites.has(model.slug));
    return models.filter((model) => model.provider === rail);
  }, [favourites, matches, models, rail, searching]);

  const current = visible.filter((model) => !model.legacy);
  const legacy = visible.filter((model) => model.legacy);

  const choose = React.useCallback(
    (model: ModelInfo) => {
      // Selecting the model selects the CLI behind it.
      harness.chooseModel(model.slug);
      setOpen(false);
      setQuery("");
    },
    [harness],
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

  const toggleFavourite = (slug: string, event: React.MouseEvent): void => {
    event.stopPropagation();
    setFavourites((existing) => {
      const next = new Set(existing);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  if (!snapshot) return null;

  const agentFor = (provider: AgentId): AgentInfo | undefined =>
    snapshot.agents.find((agent) => agent.id === provider);

  const activeAgent = active ? agentFor(active.provider) : undefined;
  const unavailable = active !== undefined && activeAgent !== undefined && !activeAgent.installed;

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
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors outline-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60",
          unavailable ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : unavailable ? (
          <CircleAlert className="size-3.5" />
        ) : active ? (
          <ProviderIcon provider={active.provider} className="size-3" />
        ) : (
          <span className="size-1.5 rounded-full bg-primary" />
        )}
        {active?.name ?? (models.length === 0 ? "Looking for models…" : "Choose a model")}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[340px] overflow-hidden p-0">
        <div className="flex">
          {!searching && (
            <div className="flex w-11 shrink-0 flex-col gap-1 border-r bg-muted/30 p-1">
              <RailButton label="Favourites" active={rail === "favorites"} onClick={() => setRail("favorites")}>
                <Star className={cn("size-4", favourites.size > 0 && "fill-current")} />
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

            <div className="max-h-[320px] overflow-y-auto p-1">
              {current.map((model, index) => (
                <ModelRow
                  key={model.slug}
                  model={model}
                  index={searching ? -1 : index}
                  active={selection?.model === model.slug}
                  agent={agentFor(model.provider)}
                  favourite={favourites.has(model.slug)}
                  onChoose={() => choose(model)}
                  onToggleFavourite={(event) => toggleFavourite(model.slug, event)}
                />
              ))}

              {current.length === 0 && legacy.length === 0 && (
                <p className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  {rail === "favorites" && !searching
                    ? "No favourites yet. Star a model to keep it here."
                    : models.length === 0
                      ? "Looking for installed CLIs…"
                      : "No models match."}
                </p>
              )}

              {!searching && legacy.length > 0 && (
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
                legacy.map((model) => (
                  <ModelRow
                    key={model.slug}
                    model={model}
                    index={-1}
                    active={selection?.model === model.slug}
                    agent={agentFor(model.provider)}
                    favourite={favourites.has(model.slug)}
                    onChoose={() => choose(model)}
                    onToggleFavourite={(event) => toggleFavourite(model.slug, event)}
                  />
                ))}
            </div>

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

function ModelRow({
  model,
  index,
  active,
  agent,
  favourite,
  onChoose,
  onToggleFavourite,
}: {
  model: ModelInfo;
  index: number;
  active: boolean;
  agent: AgentInfo | undefined;
  favourite: boolean;
  onChoose: () => void;
  onToggleFavourite: (event: React.MouseEvent) => void;
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

      <span
        role="button"
        tabIndex={-1}
        onClick={onToggleFavourite}
        className="shrink-0 text-muted-foreground/50 transition-colors hover:text-[var(--warning)]"
      >
        <Star className={cn("size-3.5", favourite && "fill-[var(--warning)] text-[var(--warning)]")} />
      </span>
    </button>
  );

  if (missing) return <Hint label={`${agent?.label} is not installed. ${agent?.installHint ?? ""}`}>{row}</Hint>;
  if (model.description) return <Hint label={model.description}>{row}</Hint>;

  return row;
}
