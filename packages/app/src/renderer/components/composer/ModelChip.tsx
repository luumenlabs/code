/**
 * Model picker.
 *
 * There is no separate CLI picker: the model implies the provider. Choosing a
 * GPT model is choosing Codex, choosing a Claude model is choosing Claude Code.
 * Asking for both was asking the same question twice.
 *
 * Searchable, with Ctrl+1…N on the current models and everything older folded
 * behind "Legacy models", so the list stays short enough to pick from without
 * reading it.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, CircleAlert, Loader2, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MODELS, findModel } from "../../../shared/models.js";
import type { ModelInfo } from "../../../shared/models.js";
import type { AgentInfo } from "../../../shared/agent.js";
import type { Harness } from "@/state";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

export function ModelChip({ harness }: { harness: Harness }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showLegacy, setShowLegacy] = React.useState(false);
  const [favourites, setFavourites] = React.useState<Set<string>>(new Set(["claude-opus-5", "claude-fable-5"]));
  const search = React.useRef<HTMLInputElement>(null);

  const snapshot = harness.snapshot;
  const selection = harness.modelSelection;
  const active = findModel(selection?.model);
  const state = snapshot?.session.state;
  const busy = state === "thinking" || state === "working" || state === "starting";

  const current = React.useMemo(() => MODELS.filter((model) => !model.legacy), []);
  const legacy = React.useMemo(() => MODELS.filter((model) => model.legacy), []);

  const matches = (model: ModelInfo): boolean =>
    model.name.toLowerCase().includes(query.trim().toLowerCase()) ||
    (PROVIDER_LABEL[model.provider] ?? "").toLowerCase().includes(query.trim().toLowerCase());

  const visibleCurrent = current.filter(matches);
  const visibleLegacy = legacy.filter(matches);

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
    setFavourites((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  if (!snapshot) return null;

  const installed = (model: ModelInfo): AgentInfo | undefined =>
    snapshot.agents.find((agent) => agent.id === model.provider);

  const activeAgent = active ? installed(active) : undefined;
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
        ) : (
          <span className="size-1.5 rounded-full bg-primary" />
        )}
        {active?.name ?? "Choose a model"}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[320px] p-0">
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

        <div className="max-h-[340px] overflow-y-auto p-1">
          {visibleCurrent.map((model, index) => (
            <ModelRow
              key={model.slug}
              model={model}
              index={index}
              active={selection?.model === model.slug}
              agent={installed(model)}
              favourite={favourites.has(model.slug)}
              onChoose={() => choose(model)}
              onToggleFavourite={(event) => toggleFavourite(model.slug, event)}
            />
          ))}

          {visibleCurrent.length === 0 && visibleLegacy.length === 0 && (
            <p className="px-2 py-3 text-[11.5px] text-muted-foreground">No models match.</p>
          )}

          {query.trim().length === 0 && (
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

          {(showLegacy || query.trim().length > 0) &&
            visibleLegacy.map((model) => (
              <ModelRow
                key={model.slug}
                model={model}
                index={-1}
                active={selection?.model === model.slug}
                agent={installed(model)}
                favourite={favourites.has(model.slug)}
                onChoose={() => choose(model)}
                onToggleFavourite={(event) => toggleFavourite(model.slug, event)}
              />
            ))}
        </div>
      </PopoverContent>
    </Popover>
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
        <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          {missing && <CircleAlert className="size-3" />}
          {PROVIDER_LABEL[model.provider] ?? model.provider}
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

  if (!missing) return row;

  return <Hint label={`${agent?.label} is not installed. ${agent?.installHint ?? ""}`}>{row}</Hint>;
}
