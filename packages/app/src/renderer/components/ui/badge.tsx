import * as React from "react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        primary: "border-primary/25 bg-primary/12 text-primary",
        success: "border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-[var(--success)]",
        warning: "border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning)_14%,transparent)] text-[var(--warning)]",
        destructive: "border-destructive/30 bg-destructive/12 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/**
 * How many things behind this button are asking to be dealt with.
 *
 * Built from the warning badge rather than given its own amber so the mark on
 * a button and the badge on the row it leads to are provably the same colour:
 * the count is a promise that something further in wears this, and following it
 * has to end at the thing you were promised.
 *
 * Nothing to say means nothing drawn — a zero is a number, and a number reads
 * as a thing to look at.
 */
export function Notice({ count, className }: { count: number; className?: string }): React.JSX.Element | null {
  if (count < 1) return null;

  return (
    <span
      className={cn(
        badgeVariants({ variant: "warning" }),
        "min-w-[18px] justify-center rounded-full px-1 tabular-nums",
        className,
      )}
    >
      {count}
    </span>
  );
}

export { badgeVariants };
