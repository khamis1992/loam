'use client';

import clsx from 'clsx';

interface HomeCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick?: () => void;
  className?: string;
}

export function HomeCard({ icon, title, subtitle, onClick, className }: HomeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex h-[104px] items-start justify-between rounded-card bg-fill-tsp p-4 text-start transition-colors hover:bg-fill-hover',
        className,
      )}
    >
      <div>
        <div className="mb-2">{icon}</div>
        <p className="text-sm font-semibold text-text-primary">{title} ›</p>
        <p className="text-xs text-text-tertiary">{subtitle}</p>
      </div>
      <div className="h-full w-16 rounded bg-current opacity-10" aria-hidden />
    </button>
  );
}
