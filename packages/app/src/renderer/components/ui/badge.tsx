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
 * How many things behind this button are asking to be dealt with. Built from
 * the warning badge, so a mark and the badge on the row it leads to are the
 * same colour. A count of zero draws nothing.
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
