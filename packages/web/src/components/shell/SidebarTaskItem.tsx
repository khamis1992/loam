import clsx from 'clsx';
import type { AgentSession } from '@/store/sessionsSlice';

export function SidebarTaskItem({ s, active, onClick }: { s: AgentSession; active: boolean; onClick: () => void }) {
  const running = s.status === 6; // SESSION_STATUS_RUNNING
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex h-row-sm w-full items-center gap-2 rounded-row ps-1.5 pe-0.5 text-start text-sm',
        active ? 'bg-fill-hover text-text-primary' : 'text-text-secondary hover:bg-fill-hover',
      )}
    >
      <span aria-hidden className="w-4 shrink-0 text-center">{s.icon || '•'}</span>
      <span className="flex-1 truncate">{s.title || 'New task'}</span>
      {running && <span className="size-1.5 animate-pulse rounded-full bg-func-success" aria-label="Working" />}
    </button>
  );
}
