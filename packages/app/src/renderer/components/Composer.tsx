import * as React from "react";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { EMPTY_DRAFT, resolveDraft, toggleOption, writeAnswer } from "@luumen/code-protocol";
import type { AskAnswer, AskDraft, AskQuestion } from "@luumen/code-protocol";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { AccessChip } from "@/components/composer/AccessChip";
import { AskPanel } from "@/components/composer/AskPanel";
import { ModelChip } from "@/components/composer/ModelChip";
import { cn } from "@/lib/utils";
import type { Attachment, Harness } from "@/state";

const MIN_HEIGHT = 76;
const MAX_HEIGHT = 300;

export function Composer({
  harness,
  value,
  onValueChange,
  onOpenPermissions,
}: {
  harness: Harness;
  value: string;
  onValueChange: (value: string) => void;
  /** Opens Settings on the permissions section, from the access chip. */
  onOpenPermissions: () => void;
}): React.JSX.Element {
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const filePicker = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);

  const snapshot = harness.snapshot;
  const session = snapshot?.session;
  const studioConnected = (snapshot?.status.sessions.length ?? 0) > 0;
  const hasModel = harness.modelSelection != null;

  // A conversation is filed against a Roblox place, so there is nowhere to put
  // one until Studio is connected.
  const ready = studioConnected && hasModel && session?.state !== "error";

  /**
   * The question the agent is waiting on, and the answer being built for it.
   * Drafts live here rather than in the panel: the box below is where a written
   * answer is typed, and one has to be able to clear the other.
   */
  const ask = harness.pendingAsk;
  const [index, setIndex] = React.useState(0);
  const [drafts, setDrafts] = React.useState<Record<string, AskDraft>>({});

  const question: AskQuestion | undefined = ask?.questions[index];
  const draft = question ? (drafts[question.id] ?? EMPTY_DRAFT) : undefined;
  const answered = question ? resolveDraft(question, draft) !== null : false;
  const last = ask ? index >= ask.questions.length - 1 : true;

  // Every question answered, wherever you are standing in the set.
  const complete = ask?.questions.every((entry) => resolveDraft(entry, drafts[entry.id]) !== null) ?? false;

  // A new question starts at the top with nothing filled in.
  React.useEffect(() => {
    setIndex(0);
    setDrafts({});
  }, [ask?.id]);

  const placeholder = ask
    ? question && question.options.length > 0
      ? "Type your own answer, or leave this blank to use the selected option"
      : "Type your answer…"
    : !studioConnected
      ? "Connect Roblox Studio…"
      : !hasModel
        ? "Pick a model…"
        : "Describe a change…";

  // A question already fills the card, so the box under it is one line until
  // the answer needs more.
  React.useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, ask ? 0 : MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [value, ask, draft?.written]);

  const addFiles = React.useCallback(async (files: FileList | File[]): Promise<void> => {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;

    const read = await Promise.all(
      images.map(
        (file) =>
          new Promise<Attachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: `att_${Math.random().toString(36).slice(2, 10)}`,
                name: file.name || "pasted image",
                mimeType: file.type,
                // Strip the data-URL prefix; the agent wants raw base64.
                data: String(reader.result).split(",")[1] ?? "",
              });
            reader.readAsDataURL(file);
          }),
      ),
    );

    setAttachments((current) => [...current, ...read].slice(0, 8));
  }, []);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if ((text.length === 0 && attachments.length === 0) || !ready) return;

    const sent = attachments;
    onValueChange("");
    setAttachments([]);

    try {
      await harness.send(text, sent);
    } catch {
      // The box was cleared before the send; this is the only copy left.
      onValueChange(text);
      setAttachments(sent);
    }
  };

  /** Sends every answer at once; the agent asked for them as one call. */
  const sendAnswers = async (): Promise<void> => {
    if (!ask) return;

    const answers: AskAnswer[] = [];

    for (const entry of ask.questions) {
      const answer = resolveDraft(entry, drafts[entry.id]);
      // Never half-filled: a missing answer would read to the agent as one.
      if (answer === null) return;
      answers.push({ questionId: entry.id, question: entry.question, answer });
    }

    await window.luuCode.answerAsk(ask.id, answers);
  };

  /**
   * Send once nothing is outstanding, otherwise go to whatever still is.
   * Stepping to the next index would strand you on the last question with an
   * earlier one blank.
   */
  const advance = (): void => {
    if (!ask || !question || !answered) return;

    if (complete) {
      void sendAnswers();
      return;
    }

    const outstanding = ask.questions.findIndex((entry) => resolveDraft(entry, drafts[entry.id]) === null);
    if (outstanding !== -1) setIndex(outstanding);
  };

  // Drafts are kept per question id, so stepping back and forth keeps them.
  const back = (): void => setIndex((current) => Math.max(0, current - 1));
  const next = (): void => {
    if (answered && !last) setIndex((current) => current + 1);
  };

  // The auto-advance timer would otherwise fire against the draft as it was
  // before the option was picked.
  const advanceRef = React.useRef(advance);
  advanceRef.current = advance;

  const onToggle = React.useCallback((entry: AskQuestion, label: string): void => {
    setDrafts((current) => ({ ...current, [entry.id]: toggleOption(entry, current[entry.id], label) }));

    // One choice is the whole answer, so picking it moves on.
    if (!entry.multiple) window.setTimeout(() => advanceRef.current(), 200);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();

    if (ask) advance();
    else void submit();
  };

  return (
    <div className="shrink-0 px-7 pt-1 pb-5">
      {/* Same width as the transcript's column, so the two line up. */}
      <div className="mx-auto w-full max-w-[804px]">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void addFiles(event.dataTransfer.files);
          }}
          className={cn(
            "rounded-xl border bg-card shadow-sm transition-colors",
            dragging ? "border-primary bg-primary/[0.04]" : focused ? "border-primary/50" : "border-border",
            !ready && "opacity-70",
          )}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="group relative">
                  <img
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name}
                    className="size-14 rounded-md border object-cover"
                  />
                  <button
                    onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}
                    className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border bg-popover text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {ask && (
            <AskPanel
              request={ask}
              index={index}
              draft={draft}
              onToggle={onToggle}
              onBack={back}
              onNext={next}
              canNext={answered}
              disabled={false}
            />
          )}

          <div className="px-4 pt-3.5 pb-1">
            <Textarea
              ref={textarea}
              rows={ask ? 1 : 3}
              value={ask && question ? (draft?.written ?? "") : value}
              disabled={ask ? false : !ready}
              placeholder={placeholder}
              onChange={(event) => {
                if (ask && question) {
                  const written = event.target.value;
                  setDrafts((current) => ({ ...current, [question.id]: writeAnswer(current[question.id], written) }));
                  return;
                }
                onValueChange(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length > 0) {
                  event.preventDefault();
                  void addFiles(files);
                }
              }}
              style={{ userSelect: "text", cursor: "auto", ...(ask ? {} : { minHeight: MIN_HEIGHT }) }}
            />
          </div>

          <div className="flex items-center gap-0.5 px-2.5 pt-0.5 pb-2.5">
            <ModelChip harness={harness} />
            {snapshot && (
              <AccessChip
                permissions={snapshot.capabilities.permissions}
                disabledTools={snapshot.capabilities.disabledTools}
                onOpenAdvanced={onOpenPermissions}
              />
            )}

            <span className="flex-1" />

            <input
              ref={filePicker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />

            <Hint label="Attach an image">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => filePicker.current?.click()}
                disabled={!ready}
                className="text-muted-foreground"
              >
                <ImagePlus />
              </Button>
            </Hint>

            {/* Stopping while a question is up dismisses it too, so the agent
                is told rather than left to time out. */}
            {harness.busy && (
              <Hint label={ask ? "Dismiss and stop" : "Stop"}>
                <Button
                  size="icon-sm"
                  variant="destructive"
                  className="rounded-full"
                  onClick={() => {
                    if (ask) void window.luuCode.cancelAsk(ask.id);
                    else void harness.interrupt();
                  }}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </Hint>
            )}

            {ask ? (
              <Button size="sm" className="ml-1 rounded-full px-3" disabled={!answered} onClick={advance}>
                {complete ? "Send" : "Next"}
              </Button>
            ) : harness.busy ? null : (
              <Button
                size="icon-sm"
                className="rounded-full"
                onClick={() => void submit()}
                disabled={!ready || (value.trim().length === 0 && attachments.length === 0)}
                title="Send"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
