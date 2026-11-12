import * as React from "react";
import { cn } from "../../lib/utils";
import { clamp } from "../../lib/utils";

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value, defaultValue = 0, onValueChange, min = 0, max = 100, step = 1, disabled, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
    const isControlled = value !== undefined;
    const current = isControlled ? value : uncontrolled;
    const percent = max === min ? 0 : ((current - min) / (max - min)) * 100;

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = clamp(Number(event.target.value), min, max);
      if (!isControlled) setUncontrolled(next);
      onValueChange?.(next);
    };

    return (
      <div className="relative flex w-full touch-none items-center">
        <div className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
          <div className="absolute h-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={disabled}
          onChange={handleChange}
          data-slot="slider"
          aria-valuenow={current}
          className={cn(
            "absolute h-4 w-4 cursor-pointer appearance-none rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          style={{ left: `calc(${percent}% - 0.5rem)` }}
          {...props}
        />
      </div>
    );
  },
);
Slider.displayName = "Slider";
