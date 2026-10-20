'use client';

import clsx from 'clsx';

interface HomeCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  illustration?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: boolean | 'menu' | 'dialog' | 'true' | 'false';
}

export function HomeCard({ icon, title, subtitle, illustration, onClick, className, 'aria-expanded': ariaExpanded, 'aria-haspopup': ariaHasPopup }: HomeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      className={clsx(
        'relative flex h-[104px] w-full items-start justify-between overflow-hidden rounded-card bg-fill-tsp p-4 text-start transition-colors hover:bg-fill-hover',
        className,
      )}
    >
      <div className="relative z-10">
        <div className="mb-2">{icon}</div>
        <p className="text-sm font-semibold text-text-primary">{title} ›</p>
        <p className="text-xs text-text-tertiary">{subtitle}</p>
      </div>
      {illustration && (
        <div className="pointer-events-none absolute -end-2 top-1/2 -translate-y-1/2 opacity-10" aria-hidden>
          {illustration}
        </div>
      )}
    </button>
  );
}
