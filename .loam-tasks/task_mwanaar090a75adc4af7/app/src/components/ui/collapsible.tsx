import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

interface CollapsibleContextValue {
  open: boolean;
  toggle: () => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | undefined>(undefined);

function useCollapsible() {
  const context = React.useContext(CollapsibleContext);
  if (!context) throw new Error("Collapsible components must be used within a Collapsible");
  return context;
}

export function Collapsible({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolled;

  const toggle = React.useCallback(() => {
    const next = !open;
    if (!isControlled) setUncontrolled(next);
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  return (
    <CollapsibleContext.Provider value={{ open, toggle }}>
      <div data-slot="collapsible" data-state={open ? "open" : "closed"} className={cn("w-full", className)} {...props} />
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ className, children, ...props }: React.ComponentProps<typeof Button>) {
  const { open, toggle } = useCollapsible();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="collapsible-trigger"
      aria-expanded={open}
      onClick={toggle}
      className={cn("w-full justify-between", className)}
      {...props}
    >
      {children}
    </Button>
  );
}

export function CollapsibleContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = useCollapsible();
  if (!open) return null;
  return (
    <div data-slot="collapsible-content" data-state={open ? "open" : "closed"} className={cn("overflow-hidden", className)} {...props}>
      {children}
    </div>
  );
}
