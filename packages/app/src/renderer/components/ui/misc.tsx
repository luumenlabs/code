/**
 * Small primitives that do not each need a file: separator, collapsible, tabs,
 * and the textarea used by the composer.
 */
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
    {...props}
  />
));

Separator.displayName = "Separator";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex h-8 items-center gap-0.5 rounded-md bg-secondary/60 p-0.5", className)}
    {...props}
  />
));

TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-[13px] font-medium text-muted-foreground transition-colors outline-none",
      "hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
));

TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = TabsPrimitive.Content;

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // The composer is the one input in the app you actually write in, so it
        // sits a step above body text rather than level with it.
        "w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-foreground outline-none",
        "placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      style={{ userSelect: "text", cursor: "auto" }}
      {...props}
    />
  ),
);

Textarea.displayName = "Textarea";

/** A labelled block in the sidebar. */
export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <header className="flex h-5 items-center justify-between">
        <h2 className="text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
