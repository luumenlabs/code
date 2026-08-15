/**
 * The Luu Code wordmark. The bulb is Luumen's own mark, inlined rather than
 * loaded so it takes `currentColor`. Syne for the wordmark, DM Sans elsewhere.
 */
import { cn } from "@/lib/utils";

/** Verbatim from luumen.dev's bulb.svg. */
const BULB_PATH =
  "m5.868 15.583a8.938 8.938 0 0 1 -2.793-7.761 9 9 0 1 1 14.857 7.941 5.741 5.741 0 0 0 -1.594 2.237h-3.338v-7.184a3 3 0 0 0 2-2.816 1 1 0 0 0 -2 0 1 1 0 0 1 -2 0 1 1 0 0 0 -2 0 3 3 0 0 0 2 2.816v7.184h-3.437a6.839 6.839 0 0 0 -1.695-2.417zm2.132 4.417v.31a3.694 3.694 0 0 0 3.69 3.69h.62a3.694 3.694 0 0 0 3.69-3.69v-.31z";

export function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-4 shrink-0 text-primary", className)}>
      <path d={BULB_PATH} fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn("flex items-center gap-[7px]", className)}>
      <BrandMark className="size-[18px]" />
      <span className="font-display text-[15.5px] leading-none font-bold tracking-[-0.01em]">Luu Code</span>
    </span>
  );
}
