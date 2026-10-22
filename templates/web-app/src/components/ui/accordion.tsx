import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

type AccordionType = "single" | "multiple";

interface AccordionContextValue {
  type: AccordionType;
  open: ReadonlySet<string>;
  toggle: (value: string) => void;
}

const AccordionContext = React.createContext<AccordionContextValue | undefined>(undefined);
const AccordionItemContext = React.createContext<string | undefined>(undefined);

function useAccordion() {
  const context = React.useContext(AccordionContext);
  if (!context) throw new Error("Accordion components must be used within an Accordion");
  return context;
}

function useAccordionItemValue() {
  const value = React.useContext(AccordionItemContext);
  if (value === undefined) throw new Error("Accordion item components must be used within an AccordionItem");
  return value;
}

export function Accordion({
  type = "single",
  defaultValue,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { type?: AccordionType; defaultValue?: string }) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => (defaultValue ? new Set([defaultValue]) : new Set()));

  const toggle = React.useCallback(
    (value: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(value)) {
          next.delete(value);
          return next;
        }
        if (type === "single") return new Set([value]);
        next.add(value);
        return next;
      });
    },
    [type],
  );

  return (
    <AccordionContext.Provider value={{ type, open, toggle }}>
      <div data-slot="accordion" className={cn("flex flex-col gap-2", className)} {...props}>
        {children}
      </div>
    </AccordionContext.Provider>
  );
}

export function AccordionItem({
  value,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const { open } = useAccordion();
  const isOpen = open.has(value);
  return (
    <AccordionItemContext.Provider value={value}>
      <div
        data-slot="accordion-item"
        data-state={isOpen ? "open" : "closed"}
        className={cn("rounded-lg border px-4", className)}
        {...props}
      >
        {children}
      </div>
    </AccordionItemContext.Provider>
  );
}

export function AccordionTrigger({ className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle } = useAccordion();
  const value = useAccordionItemValue();
  const isOpen = open.has(value);
  return (
    <button
      type="button"
      data-slot="accordion-trigger"
      aria-expanded={isOpen}
      onClick={() => toggle(value)}
      className={cn("flex w-full items-center justify-between py-4 text-sm font-medium transition-colors hover:underline", className)}
      {...props}
    >
      {children}
      <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} />
    </button>
  );
}

export function AccordionContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = useAccordion();
  const value = useAccordionItemValue();
  if (!open.has(value)) return null;
  return (
    <div data-slot="accordion-content" className={cn("overflow-hidden pb-4 text-sm", className)} {...props}>
      {children}
    </div>
  );
}
