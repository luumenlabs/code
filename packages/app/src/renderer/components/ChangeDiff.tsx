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
import { bundleDocument, lineCount } from "@/components/changeDocument";
import type { ChangeBundle } from "@/components/changeDocument";
import { cn } from "@/lib/utils";

/**
 * Borrowed for the syntax colours only.
 *
 * A bundled theme is a whole palette: its own background, its own greys, its
 * own green and red, its own idea of how big code should be. Dropping all of
 * that into a window painted from `styles.css` is what made the diff read as a
 * screenshot of a different program — a blue-black panel with GitHub's green
 * in it, sitting inside a neutral card. Only the token colours are worth
 * taking; `SURFACE` takes back the rest.
 */
const THEME = { dark: "github-dark-default", light: "github-light-default" } as const;

/**
 * Every surface, colour, and metric the diff shows, bound to the app's own.
 *
 * Custom properties inherit through a shadow root like anywhere else, so
 * `var(--background)` inside the component resolves to the same value the rest
 * of the window is painted with — including the light and dark flip, which the
 * app has already made. The library puts `unsafe` last in its own `@layer`
 * order for exactly this, so these win over the theme it generated.
 *
 * Additions and deletions are the app's success and destructive colours rather
 * than a green and a red of their own. A diff is not the one place in the
 * product where "this went well" should be a different green.
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

/**
 * Below this, line numbers are furniture.
 *
 * A rename renders as one line on each side. Numbering it puts a gutter, a
 * rule, and the digit 1 around two words, which is most of the row spent on
 * saying that the row is the first one.
 */
const NUMBERED_FROM = 12;

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
      // The row above already says which instance and what happened to it; a
      // second header inside the diff repeating the filename is noise.
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
