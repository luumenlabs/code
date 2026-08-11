/**
 * The diff itself, rendered by @pierre/diffs.
 *
 * The alignment, the hunking, the syntax highlighting, and the split view are
 * all the library's. What is left here is the two sides of the file and the
 * theme — which is the amount of diff code this product should own.
 *
 * It ships its own Shiki grammars and themes and makes no network calls, which
 * is the property that matters: Luu Code runs on 127.0.0.1 and a highlighter
 * that fetched a grammar would quietly break that promise.
 */
import * as React from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { ChangeRecord } from "@luumen/code-protocol";
import { changeDocument } from "@/components/changeDocument";
import { cn } from "@/lib/utils";

/** Matches the app's own dark and light palettes closely enough to disappear. */
const THEME = { dark: "github-dark-default", light: "github-light-default" } as const;

function useThemeType(): "dark" | "light" {
  // Tailwind's `dark` variant is class-based here, so the class on <html> is the
  // authority — not the OS preference, which the user may have overridden.
  const [isDark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));

  React.useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setDark(target.classList.contains("dark")));
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark ? "dark" : "light";
}

export function ChangeDiff({
  record,
  split,
  className,
}: {
  record: ChangeRecord;
  /** Side-by-side. Only worth it when there is room for two columns. */
  split?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const themeType = useThemeType();
  const document = React.useMemo(() => changeDocument(record), [record]);

  if (!document) {
    return (
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {record.reason ?? "Nothing to show."}
      </p>
    );
  }

  const { name, before, after } = document;

  if (before === null && after === null) {
    return (
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {record.reason ?? "No copy of this was kept."}
      </p>
    );
  }

  const options = {
    theme: THEME,
    themeType,
    diffStyle: split ? ("split" as const) : ("unified" as const),
    // The row above already says which instance and what happened to it; a
    // second header inside the diff repeating the filename is noise.
    disableFileHeader: true,
    overflow: "scroll" as const,
    stickyHeader: false,
  };

  return (
    <div className={cn("overflow-hidden rounded-md border text-[11.5px]", className)}>
      <MultiFileDiff
        {...(before === null
          ? { oldFile: null, newFile: { name, contents: after as string } }
          : after === null
            ? { oldFile: { name, contents: before }, newFile: null }
            : { oldFile: { name, contents: before }, newFile: { name, contents: after } })}
        options={options}
      />
    </div>
  );
}
