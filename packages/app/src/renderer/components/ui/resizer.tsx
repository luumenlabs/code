/**
 * The edge you drag to resize a panel.
 *
 * Two pixels wide and invisible until you reach for it, with a much larger
 * hit area either side: a border you have to hit exactly is a border nobody
 * discovers, and one that is visibly thick enough to grab is a line drawn
 * through the window for no reason.
 *
 * Pointer capture rather than window listeners, so a drag that leaves the
 * window — which it will, because the whole point is to pull the edge outward —
 * keeps sending events to the handle instead of stopping halfway.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export function Resizer({
  side,
  width,
  min,
  max,
  onChange,
  onCommit,
  label,
}: {
  /** Which edge of the window the panel is attached to. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  /** Fires continuously while dragging, so the panel tracks the pointer. */
  onChange: (width: number) => void;
  /** Fires once, at the end, which is the only value worth storing. */
  onCommit: (width: number) => void;
  label: string;
}): React.JSX.Element {
  const start = React.useRef<{ x: number; width: number } | null>(null);
  const latest = React.useRef(width);
  latest.current = width;

  const clamp = (value: number): number => Math.round(Math.min(max, Math.max(min, value)));

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Left button only. A right-click here is a context menu, not a drag.
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    if (!from) return;

    // A panel on the right grows as the pointer moves left, so the delta is
    // inverted rather than the panel being laid out backwards.
    const delta = side === "left" ? event.clientX - from.x : from.x - event.clientX;
    onChange(clamp(from.width + delta));
  };

  const end = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!start.current) return;
    start.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(latest.current);
  };

  /** Keyboard resizing, because a drag handle that only takes a mouse is not a control. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 8;
    const outward = side === "left" ? "ArrowRight" : "ArrowLeft";
    const inward = side === "left" ? "ArrowLeft" : "ArrowRight";

    if (event.key !== outward && event.key !== inward) return;
    event.preventDefault();

    const next = clamp(width + (event.key === outward ? step : -step));
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        // Back to whichever end it is furthest from, which is what a
        // double-click on a splitter does everywhere else.
        const next = width - min < max - width ? max : min;
        onChange(next);
        onCommit(next);
      }}
      className={cn(
        "group relative z-10 w-px shrink-0 cursor-col-resize bg-sidebar-border",
        "outline-none focus-visible:bg-primary",
      )}
    >
      {/* The grab area, wider than the line and centred on it. */}
      <span className="absolute inset-y-0 -left-[3px] -right-[3px] block" />
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 -left-px -right-px block bg-primary/70 opacity-0 transition-opacity",
          "group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      />
    </div>
  );
}
