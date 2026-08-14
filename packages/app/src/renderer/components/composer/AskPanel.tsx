/**
 * The agent's question, asked where you answer everything else.
 *
 * It sits above the composer's text box rather than in the conversation: the
 * agent is stopped waiting on it, so it belongs with the controls you act
 * with, not in the scrollback you read. The box below doubles as the answer
 * field, which is why this draws only the question and its options.
 *
 * One question at a time. Four stacked at once is a survey, and the counter
 * beside the header is what says there is more coming.
 */
import * as React from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { AskDraft, AskQuestion, AskRequest } from "@luumen/code-protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AskPanel({
  request,
  index,
  draft,
  onToggle,
  onBack,
  onNext,
  canNext,
  disabled,
}: {
  request: AskRequest;
  /** Which question is on screen; the composer owns the position. */
  index: number;
  draft: AskDraft | undefined;
  onToggle: (question: AskQuestion, label: string) => void;
  onBack: () => void;
  onNext: () => void;
  /** False while the question on screen has nothing to send. */
  canNext: boolean;
  disabled: boolean;
}): React.JSX.Element | null {
  const question = request.questions[index];

  // Typing is choosing not to use the options, so they stop looking chosen.
  const writing = (draft?.written.trim().length ?? 0) > 0;

  /**
   * Number keys pick an option, unless you are typing.
   *
   * The composer's box is focused for most of this panel's life, so the guard
   * is what stops "2" in a written answer from selecting the second option.
   */
  React.useEffect(() => {
    if (!question || disabled) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > question.options.length) return;

      const option = question.options[digit - 1];
      if (!option) return;

      event.preventDefault();
      onToggle(question, option.label);
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [question, disabled, onToggle]);

  if (!question) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {question.header ?? "Question"}
        </span>

        {/* Only a set of questions has a position to report, or anywhere to go.
            Back exists because a single choice moves on by itself: pick the
            wrong one and without this there is no way back to it. */}
        {request.questions.length > 1 && (
          <>
            <span className="flex h-4 items-center rounded bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground tabular-nums">
              {index + 1}/{request.questions.length}
            </span>

            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 text-muted-foreground"
                disabled={disabled || index === 0}
                onClick={onBack}
                title="Previous question"
                aria-label="Previous question"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 text-muted-foreground"
                disabled={disabled || !canNext || index >= request.questions.length - 1}
                onClick={onNext}
                title="Next question"
                aria-label="Next question"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </div>

      <p className="selectable text-[13.5px] leading-relaxed">{question.question}</p>
      {question.multiple && question.options.length > 0 && (
        <p className="text-[12px] text-muted-foreground">Pick as many as apply.</p>
      )}

      {question.options.length > 0 && (
        <div className="flex flex-col gap-1">
          {question.options.map((option, position) => {
            const picked = !writing && (draft?.selected.includes(option.label) ?? false);

            return (
              <button
                key={option.label}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(question, option.label)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  picked
                    ? "border-primary/30 bg-primary/10"
                    : "border-transparent bg-muted/25 hover:border-border/50 hover:bg-muted/40",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{option.label}</span>
                  {option.description && option.description !== option.label && (
                    <span className="text-[12px] leading-snug text-muted-foreground">{option.description}</span>
                  )}
                </span>

                {/* The number is the shortcut that picks it, so it gives way to
                    the tick once that has happened. */}
                {picked ? (
                  <Check className="size-3.5 shrink-0 text-primary" />
                ) : (
                  position < 9 && (
                    <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/50 bg-background/40 text-[11px] font-medium text-muted-foreground tabular-nums group-hover:text-foreground">
                      {position + 1}
                    </kbd>
                  )
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
