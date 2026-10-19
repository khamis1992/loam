'use client';

import { ArrowLeft, ArrowRight, Minus, PanelLeft, Search, Square, X } from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch, useAppSelector } from '@/store';
import { toggleSidebar } from '@/store/uiSlice';

function TitleButton({
  label, children, className, disabled, onClick,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex size-7 items-center justify-center rounded-control text-text-secondary',
        'transition-colors hover:bg-fill-hover hover:text-text-primary',
        'disabled:opacity-40',
        className,
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

export function TitleBar({ children }: { children?: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const sidebarOpen = useAppSelector((s) => s.ui.sidebarOpen);

  return (
    <header
      className="relative flex h-titlebar shrink-0 items-center justify-between gap-2 pe-0"
      style={{
        paddingInlineStart: 80,
        WebkitAppRegion: 'drag',
        background: 'linear-gradient(to right, var(--background-nav) 240px, var(--background-gray-main) 240px)',
      } as React.CSSProperties}
    >
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <TitleButton
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => dispatch(toggleSidebar())}
          className={sidebarOpen ? 'text-text-secondary' : 'text-text-primary'}
        >
          <PanelLeft size={16} strokeWidth={1.75} />
        </TitleButton>
        <TitleButton label="Back" disabled>
          <ArrowLeft size={16} strokeWidth={1.75} />
        </TitleButton>
        <TitleButton label="Forward" disabled>
          <ArrowRight size={16} strokeWidth={1.75} />
        </TitleButton>
        <TitleButton label="Search">
          <Search size={16} strokeWidth={1.75} />
        </TitleButton>
        {children}
      </div>

      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          aria-label="Minimize"
          className="flex h-titlebar w-[46px] items-center justify-center text-text-secondary hover:bg-fill-hover"
        >
          <Minus size={16} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Maximize"
          className="flex h-titlebar w-[46px] items-center justify-center text-text-secondary hover:bg-fill-hover"
        >
          <Square size={14} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Close"
          className="flex h-titlebar w-[46px] items-center justify-center text-text-secondary hover:bg-[#e81123] hover:text-white"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
