import { forwardRef, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-text-primary text-text-onblack hover:opacity-90',
  secondary: 'bg-bg-menu text-text-primary shadow-card hover:bg-fill-hover',
  ghost: 'bg-transparent text-text-secondary hover:bg-fill-hover hover:text-text-primary',
  danger: 'bg-func-error text-white hover:opacity-90',
};
const sizes: Record<Size, string> = {
  sm: 'h-row-sm px-3 text-sm',
  md: 'h-row px-3.5 text-sm',
  lg: 'h-control px-4 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-control font-medium',
        'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

export function IconButton({
  label, className, ...rest
}: ButtonProps & { label: string }) {
  return (
    <Button
      variant="ghost" size="sm" aria-label={label} title={label}
      className={clsx('w-row-sm px-0', className)} {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx('animate-spin', className)} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
