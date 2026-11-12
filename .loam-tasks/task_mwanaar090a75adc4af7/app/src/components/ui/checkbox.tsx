import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export interface CheckboxProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked, defaultChecked = false, onCheckedChange, disabled, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultChecked);
    const isControlled = checked !== undefined;
    const isChecked = isControlled ? checked : uncontrolled;

    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={isChecked}
        data-slot="checkbox"
        data-state={isChecked ? "checked" : "unchecked"}
        disabled={disabled}
        onClick={() => {
          const next = !isChecked;
          if (!isControlled) setUncontrolled(next);
          onCheckedChange?.(next);
        }}
        className={cn(
          "peer size-4 shrink-0 rounded-sm border border-input shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary",
          className,
        )}
        {...props}
      >
        {isChecked ? <Check className="size-3.5" /> : null}
      </button>
    );
  },
);
Checkbox.displayName = "Checkbox";
