/**
 * The diff itself, rendered by @pierre/diffs. The alignment, hunking,
 * highlighting, and split view are the library's; what is here is the two sides
 * of the file and the theme. It makes no network calls, which Luu Code needs.
 */
import * as React from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { bundleDocument, lineCount } from "@/components/changeDocument";
import type { ChangeBundle } from "@/components/changeDocument";
import { cn } from "@/lib/utils";

/** Borrowed for the syntax colours only; `SURFACE` takes back the rest. */
const THEME = { dark: "github-dark-default", light: "github-light-default" } as const;

/**
 * Every surface, colour, and metric the diff shows, bound to the app's own.
 * Custom properties inherit through the shadow root, and the library puts
 * `unsafe` last in its `@layer` order, so these win over its generated theme.
 */
const SURFACE = `
:host {
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-addition-color-override: var(--success);
  --diffs-deletion-color-override: var(--destructive);
  --diffs-modified-color-override: var(--primary);
  --diffs-font-family: var(--font-mono, "JetBrains Mono Variable", ui-monospace, monospace);
  --diffs-header-font-family: var(--font-sans, system-ui, sans-serif);
  --diffs-font-size: 11.5px;
  --diffs-line-height: 19px;
}
`;

/** Below this, line numbers are furniture — a rename is one line each side. */
const NUMBERED_FROM = 12;

function useThemeType(): "dark" | "light" {
  // Tailwind's `dark` variant is class-based here, so the class on <html> is
  // the authority, not the OS preference.
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
  bundle,
  split,
  className,
}: {
  /** Every record the row stands for, so the diff is the one they add up to. */
  bundle: ChangeBundle;
  /** Side-by-side. Only worth it when there is room for two columns. */
  split?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const themeType = useThemeType();
  const document = React.useMemo(() => bundleDocument(bundle), [bundle]);
  const reason = bundle.records[bundle.records.length - 1]?.reason ?? null;

  const longest = document ? Math.max(lineCount(document.before ?? ""), lineCount(document.after ?? "")) : 0;

  const options = React.useMemo(
    () => ({
      theme: THEME,
      themeType,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      // The row above already names the instance and what happened to it.
      disableFileHeader: true,
      disableLineNumbers: longest < NUMBERED_FROM,
      overflow: "scroll" as const,
      stickyHeader: false,
      unsafeCSS: SURFACE,
    }),
    [themeType, split, longest],
  );

  if (!document) {
    return (
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {reason ?? "Nothing to show."}
      </p>
    );
  }

  const { name, before, after } = document;

  if (before === null && after === null) {
    return (
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {reason ?? "No copy of this was kept."}
      </p>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-md border bg-background text-[11.5px]", className)}>
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
