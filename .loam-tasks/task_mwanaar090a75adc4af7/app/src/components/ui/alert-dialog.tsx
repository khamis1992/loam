import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  useDialogContext,
} from "./dialog";

export const AlertDialog = Dialog;

export const AlertDialogTrigger = DialogTrigger;

export function AlertDialogContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <DialogContent
      role="alertdialog"
      data-slot="alert-dialog-content"
      className={cn("max-w-md", className)}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

export function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <DialogHeader className={cn("gap-2", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <DialogFooter className={className} {...props} />;
}

export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;
export const AlertDialogClose = DialogClose;

export function AlertDialogAction({
  className,
  children,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onOpenChange } = useDialogContext();
  return (
    <Button
      type="button"
      className={className}
      onClick={(event) => {
        onOpenChange(false);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </Button>
  );
}

export function AlertDialogCancel({
  className,
  children,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onOpenChange } = useDialogContext();
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      onClick={(event) => {
        onOpenChange(false);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </Button>
  );
}
