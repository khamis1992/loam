import * as React from "react";
import { cn } from "../../lib/utils";

interface RadioGroupContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | undefined>(undefined);

function useRadioGroup() {
  const context = React.useContext(RadioGroupContext);
  if (!context) throw new Error("RadioGroup components must be used within a RadioGroup");
  return context;
}

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onValueChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({ className, value, defaultValue = "", onValueChange, ...props }: RadioGroupProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value !== undefined ? value : uncontrolled;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  return (
    <RadioGroupContext.Provider value={{ value: current, onValueChange: handleValueChange }}>
      <div role="radiogroup" data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />
    </RadioGroupContext.Provider>
  );
}

export interface RadioGroupItemProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  value: string;
  disabled?: boolean;
}

export function RadioGroupItem({ className, value, disabled, ...props }: RadioGroupItemProps) {
  const { value: selected, onValueChange } = useRadioGroup();
  const isSelected = selected === value;
  const id = React.useId();

  return (
    <label
      data-slot="radio-group-item"
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-2 text-sm font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <button
        id={id}
        type="button"
        role="radio"
        aria-checked={isSelected}
        data-state={isSelected ? "checked" : "unchecked"}
        disabled={disabled}
        onClick={() => onValueChange(value)}
        className={cn(
          "flex size-4 items-center justify-center rounded-full border border-input shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className={cn("size-2 rounded-full bg-primary", isSelected ? "block" : "hidden")} />
      </button>
      {props.children}
    </label>
  );
}
