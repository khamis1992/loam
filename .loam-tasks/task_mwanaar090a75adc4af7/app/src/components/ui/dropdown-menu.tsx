import * as React from "react";
import { cn } from "../../lib/utils";
import { Slot } from "./slot";

interface DropdownMenuContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | undefined>(undefined);

function useDropdownMenu(): DropdownMenuContextValue {
  const context = React.useContext(DropdownMenuContext);
  if (!context) throw new Error("DropdownMenu components must be used within a DropdownMenu");
  return context;
}

export function DropdownMenu({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const current = isControlled ? open : uncontrolled;

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return (
    <DropdownMenuContext.Provider value={{ open: current, onOpenChange: handleOpenChange }}>
      <div data-slot="dropdown-menu" className="relative inline-block">
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  asChild = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const { open, onOpenChange } = useDropdownMenu();
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onOpenChange(!open);
    props.onClick?.(event);
  };
  if (asChild) {
    return (
      <Slot
        aria-haspopup="menu"
        aria-expanded={open}
        data-slot="dropdown-menu-trigger"
        onClick={handleClick}
        className={className}
      >
        {children}
      </Slot>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      data-slot="dropdown-menu-trigger"
      onClick={handleClick}
      className={className}
      {...props}
    >
      {children}
    </button>
  );
}

export function DropdownMenuContent({
  className,
  children,
  align = "start",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" }) {
  const { open, onOpenChange } = useDropdownMenu();
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      data-slot="dropdown-menu-content"
      className={cn(
        "absolute z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        align === "end" ? "end-0" : "start-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DropdownMenuItem({
  className,
  children,
  onSelect,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { onSelect?: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const { onOpenChange } = useDropdownMenu();
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="dropdown-menu-item"
      onClick={(event) => {
        onSelect?.(event);
        onOpenChange(false);
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
