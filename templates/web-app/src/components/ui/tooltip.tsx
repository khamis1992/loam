import * as React from "react";
import { cn } from "../../lib/utils";

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: React.ReactElement;
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          data-slot="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-md",
            side === "top" ? "bottom-full mb-2 left-1/2 -translate-x-1/2" : "top-full mt-2 left-1/2 -translate-x-1/2",
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
