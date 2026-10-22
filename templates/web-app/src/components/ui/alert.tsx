import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "../../lib/utils";

type Variant = "default" | "destructive" | "warning" | "info" | "success";

const variants: Record<Variant, string> = {
  default: "bg-card text-card-foreground",
  destructive: "border-destructive/50 text-destructive",
  warning: "border-primary/50 text-primary",
  info: "border-primary/50 text-primary",
  success: "border-primary/50 text-primary",
};

const icons: Record<Variant, typeof Info> = {
  default: Info,
  destructive: XCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
}

export function Alert({ className, variant = "default", ...props }: AlertProps) {
  const Icon = icons[variant];
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        "relative w-full rounded-lg border px-4 py-3 text-sm [&_svg]:absolute [&_svg]:start-4 [&_svg]:top-4 [&_svg]:size-4 [&>div]:ps-8",
        variants[variant],
        className,
      )}
      {...props}
    >
      <Icon className="size-4" aria-hidden />
      {props.children}
    </div>
  );
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="alert-title" className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="alert-description" className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />;
}
