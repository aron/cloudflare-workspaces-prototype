import * as React from "react";
import { cn } from "@/lib/utils";

export const ButtonGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
>(({ className, orientation: _orientation, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "inline-flex items-center [&>button]:rounded-none [&>button:first-child]:rounded-l-md [&>button:last-child]:rounded-r-md [&>button:not(:last-child)]:border-r-0",
      className
    )}
    {...props}
  />
));
ButtonGroup.displayName = "ButtonGroup";

export const ButtonGroupText = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center px-3 text-sm text-kumo-inactive tabular-nums",
      className
    )}
    {...props}
  />
));
ButtonGroupText.displayName = "ButtonGroupText";
