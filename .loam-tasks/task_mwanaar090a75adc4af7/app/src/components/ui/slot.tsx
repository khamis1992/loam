import * as React from "react";

/**
 * Minimal slot primitive: merges its props into a single child element so a
 * component can render *as* its child (the shadcn `asChild` pattern) without a
 * Radix dependency. Event handlers run child-first, then slot.
 */
type AnyProps = Record<string, unknown>;

function mergeProps(slotProps: AnyProps, childProps: AnyProps): AnyProps {
  const override: AnyProps = { ...childProps };
  for (const key of Object.keys(slotProps)) {
    const slotValue = slotProps[key];
    const childValue = childProps[key];
    if (/^on[A-Z]/.test(key)) {
      if (typeof slotValue === "function" && typeof childValue === "function") {
        override[key] = (...args: unknown[]) => {
          childValue(...args);
          slotValue(...args);
        };
      } else {
        override[key] = slotValue ?? childValue;
      }
    } else if (key === "style") {
      override[key] = { ...(slotValue as object), ...(childValue as object) };
    } else if (key === "className") {
      override[key] = [slotValue, childValue].filter(Boolean).join(" ");
    } else {
      override[key] = slotValue;
    }
  }
  return override;
}

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  /** Forwarded to the single child element (React 19 treats ref as a prop). */
  ref?: React.Ref<HTMLElement>;
}

export function Slot({ children, ref, ...props }: SlotProps) {
  const count = React.Children.count(children);
  if (count !== 1) throw new Error("Slot requires exactly one child element");
  const child = React.Children.only(children);
  if (!React.isValidElement(child)) throw new Error("Slot child must be a React element");
  const merged = mergeProps({ ...props, ref }, child.props as AnyProps);
  return React.cloneElement(child, merged as React.Attributes);
}
