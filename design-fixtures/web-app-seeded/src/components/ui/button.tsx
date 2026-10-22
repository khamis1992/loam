import type { ReactNode } from "react";

interface ButtonProps {
  children?: ReactNode;
  variant?: "default" | "outline";
}

export function Button({ children, variant = "default" }: ButtonProps) {
  return <button data-variant={variant}>{children}</button>;
}
