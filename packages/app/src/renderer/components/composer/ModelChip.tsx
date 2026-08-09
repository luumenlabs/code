/**
 * Model picker.
 *
 * Searchable, with Ctrl+1…N on the current models and everything older folded
 * behind "Legacy models" — the list should stay short enough to pick from
 * without reading it. Only models for the running agent are offered, because a
 * Claude slug means nothing to Codex.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, Search, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { createSelection, findModel, modelsFor } from "../../../shared/models.js";
import type { ModelSelection } from "../../../shared/models.js";
import type { AgentId } from "../../../shared/agent.js";

export function ModelChip({
  agent,
  selection,
  onChange,
}: {
  agent: AgentId | null;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showLegacy, setShowLegacy] = React.useState(false);
  const search = React.useRef<HTMLInputElement>(null);

  const all = React.useMemo(() => (agent ? modelsFor(agent) : []), [agent]);
  const current = React.useMemo(() => all.filter((model) => !model.legacy), [all]);
  const legacy = React.useMemo(() => all.filter((model) => model.legacy), [all]);

  const matches = React.useCallback(
    (name: string) => name.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );

  const visibleCurrent = current.filter((model) => matches(model.name));
  const visibleLegacy = legacy.filter((model) => matches(model.name));

  // Ctrl+1…N picks from the current models, matching their shortcut hints.
  React.useEffect(() => {
    if (!agent) return;

    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.shiftKey) return;

      const index = Number.parseInt(event.key, 10) - 1;
      const model = current[index];
      if (!Number.isInteger(index) || !model) return;

      event.preventDefault();
      onChange(createSelection(agent, model.slug));
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, current, onChange]);

  if (!agent) return null;

  const active = findModel(selection?.model);

  const choose = (slug: string): void => {
    onChange(createSelection(agent, slug));
    setOpen(false);
    setQuery("");
  };

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
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors outline-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60",
        )}
      >
        <Sparkles className="size-3.5 text-primary" />
        {active?.name ?? "Choose a model"}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[300px] p-0">
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
          {visibleCurrent.map((model, index) => (
            <button
              key={model.slug}
              onClick={() => choose(model.slug)}
              data-active={selection?.model === model.slug}
              className="row flex w-full items-center gap-2 px-2 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{model.name}</span>
                <span className="block text-[10.5px] text-muted-foreground capitalize">{model.provider}</span>
              </span>
              {index < 9 && (
                <kbd className="shrink-0 rounded border px-1 py-px font-mono text-[9.5px] text-muted-foreground">
                  Ctrl+{index + 1}
                </kbd>
              )}
            </button>
          ))}

          {visibleCurrent.length === 0 && visibleLegacy.length === 0 && (
            <p className="px-2 py-3 text-[11.5px] text-muted-foreground">No models match.</p>
          )}

          {legacy.length > 0 && query.trim().length === 0 && (
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
              <button
                key={model.slug}
                onClick={() => choose(model.slug)}
                data-active={selection?.model === model.slug}
                className="row flex w-full items-center gap-2 px-2 py-1.5 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{model.name}</span>
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
