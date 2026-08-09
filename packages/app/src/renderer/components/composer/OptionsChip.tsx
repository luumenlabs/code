/**
 * Per-model options: reasoning effort, context window, fast mode.
 *
 * Rendered from whatever the selected model declares, so Opus 5 shows Fast Mode
 * and Fable 5 does not without either being special-cased here. The chip label
 * summarises the settings that change the answer.
 */
import * as React from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { describeOptions, effectiveOption, findModel, withOption } from "../../../shared/models.js";
import type { ModelSelection } from "../../../shared/models.js";

export function OptionsChip({
  selection,
  onChange,
}: {
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}): React.JSX.Element | null {
  const info = findModel(selection?.model);
  if (!info || !selection || info.options.length === 0) return null;

  const label = describeOptions(selection);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors outline-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60",
        )}
      >
        <Gauge className="size-3.5" />
        {label || "Options"}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[220px] p-1">
        {info.options.map((descriptor, index) => (
          <div key={descriptor.id}>
            {index > 0 && <div className="my-1 h-px bg-border" />}
            <div className="px-2 py-1 text-[10.5px] font-medium text-muted-foreground">{descriptor.label}</div>

            {descriptor.kind === "select"
              ? descriptor.choices.map((choice) => {
                  const active = effectiveOption(selection, descriptor) === choice.value;
                  return (
                    <button
                      key={choice.value}
                      onClick={() => onChange(withOption(selection, descriptor.id, choice.value))}
                      data-active={active}
                      className="row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]"
                    >
                      <span className="flex-1">{choice.label}</span>
                      {choice.isDefault && !active && (
                        <span className="text-[10px] text-muted-foreground">Default</span>
                      )}
                      {active && <Check className="size-3 shrink-0 text-primary" />}
                    </button>
                  );
                })
              : (["on", "off"] as const).map((state) => {
                  const enabled = effectiveOption(selection, descriptor) === true;
                  const active = state === "on" ? enabled : !enabled;
                  return (
                    <button
                      key={state}
                      onClick={() => onChange(withOption(selection, descriptor.id, state === "on"))}
                      data-active={active}
                      className="row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] capitalize"
                    >
                      <span className="flex-1">{state}</span>
                      {active && <Check className="size-3 shrink-0 text-primary" />}
                    </button>
                  );
                })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
