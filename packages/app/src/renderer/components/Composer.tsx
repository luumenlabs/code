import * as React from "react";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { AccessChip } from "@/components/composer/AccessChip";
import { ModelChip } from "@/components/composer/ModelChip";
import { OptionsChip } from "@/components/composer/OptionsChip";
import { cn } from "@/lib/utils";
import type { Attachment, Harness } from "@/state";

const MIN_HEIGHT = 64;
const MAX_HEIGHT = 260;

export function Composer({
  harness,
  value,
  onValueChange,
}: {
  harness: Harness;
  value: string;
  onValueChange: (value: string) => void;
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

  const placeholder = !studioConnected
    ? "Connect Roblox Studio to start."
    : !hasModel
      ? "Pick a model below to start."
      : "Describe a change to your game…";

  React.useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [value]);

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

    onValueChange("");
    setAttachments([]);
    await harness.send(text, attachments);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pt-1 pb-4">
      <div className="mx-auto max-w-[860px]">
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

          <div className="px-3.5 pt-3 pb-1">
            <Textarea
              ref={textarea}
              rows={3}
              value={value}
              disabled={!ready}
              placeholder={placeholder}
              onChange={(event) => onValueChange(event.target.value)}
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
              style={{ userSelect: "text", cursor: "auto", minHeight: MIN_HEIGHT }}
            />
          </div>

          <div className="flex items-center gap-0.5 px-2 pt-0.5 pb-2">
            <ModelChip harness={harness} />
            <OptionsChip selection={harness.modelSelection} onChange={harness.setModelSelection} />
            {snapshot && <AccessChip permissions={snapshot.capabilities.permissions} />}

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

            <Hint label="Attach an image — or just paste one">
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

            {harness.busy ? (
              <Hint label="Stop the agent">
                <Button
                  size="icon-sm"
                  variant="destructive"
                  className="rounded-full"
                  onClick={() => void harness.interrupt()}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </Hint>
            ) : (
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
