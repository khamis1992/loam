import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
}

/**
 * Styled select built on the native <select> so keyboard, screen-reader and
 * mobile behaviour stay correct without a Radix dependency.
 */
export function Select({
  value,
  defaultValue = "",
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  ...props
}: SelectProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const isControlled = value !== undefined;
  const current = isControlled ? value : uncontrolled;

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isControlled) setUncontrolled(next);
    onValueChange?.(next);
  };

  return (
    <div className="relative">
      <select
        value={current}
        disabled={disabled}
        onChange={handleChange}
        data-slot="select"
        className={cn(
          "flex h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pe-8 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 opacity-50" />
    </div>
  );
}
