import type { ReactNode } from "react";

interface TooltipProps {
  children?: ReactNode;
}

export function Tooltip({ children }: TooltipProps) {
  return <span data-tooltip>{children}</span>;
}

export function TooltipTrigger({ children }: TooltipProps) {
  return <span data-trigger>{children}</span>;
}

export function TooltipContent({ children }: TooltipProps) {
  return <span data-content>{children}</span>;
}

export function TooltipProvider({ children }: TooltipProps) {
  return <span data-provider>{children}</span>;
}
