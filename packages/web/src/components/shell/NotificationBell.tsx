'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, X } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

const POLL_MS = 20_000;

const KIND_LABEL: Record<string, string> = {
  'task-done': 'Completed',
  'task-failed': 'Failed',
  'approval-pending': 'Approval',
  'schedule-failed': 'Routine',
};

/** Sidebar bell (option #20): unread badge, dropdown feed, mark-read controls. */
export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/notifications?limit=50`, { headers: await getApiHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { notifications?: NotificationItem[] };
      if (Array.isArray(data.notifications)) setItems(data.notifications);
    } catch {
      // the feed is passive: failures just keep the last snapshot
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const unread = items.filter((n) => !n.read_at).length;

  const markRead = async (id: string) => {
    try {
      await fetch(`${getApiBase()}/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
    } catch { /* ignore */ }
    void load();
  };

  const markAll = async () => {
    try {
      await fetch(`${getApiBase()}/api/notifications/read-all`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
    } catch { /* ignore */ }
    void load();
  };

  const openItem = (n: NotificationItem) => {
    setOpen(false);
    void markRead(n.id);
    router.push('/app/computers');
  };

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        aria-label={t('Notifications')}
        title={t('Notifications')}
        onClick={() => { setOpen((v) => !v); if (!open) void load(); }}
        className={clsx('relative flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover', open && 'bg-fill-hover text-text-primary')}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 end-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#0081f2] px-1 text-[9px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('Notifications')}
          className="absolute bottom-full end-0 z-50 mb-2 flex max-h-[420px] w-[300px] flex-col overflow-hidden rounded-card border border-border-main bg-bg-menu shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border-main px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">{t('Notifications')}</span>
            <button
              type="button"
              onClick={() => void markAll()}
              disabled={unread === 0}
              className="flex items-center gap-1 text-[11px] text-icon-blue disabled:opacity-40"
            >
              <CheckCheck className="size-3" />
              {t('Mark all read')}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {items.length === 0 && (
              <p className="py-8 text-center text-xs text-text-tertiary">{t('No notifications')}</p>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void openItem(n)}
                className={clsx(
                  'group flex w-full flex-col gap-0.5 rounded-control px-2 py-2 text-start hover:bg-fill-hover',
                  !n.read_at && 'bg-fill-tsp',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={clsx(
                      'rounded px-1 text-[10px] font-medium',
                      n.kind === 'task-done' && 'bg-green-50 text-green-600 dark:bg-green-950',
                      n.kind === 'task-failed' && 'bg-red-50 text-function-error dark:bg-red-950',
                      n.kind === 'schedule-failed' && 'bg-amber-50 text-function-warning dark:bg-amber-950',
                      n.kind === 'approval-pending' && 'bg-blue-50 text-icon-blue dark:bg-blue-950',
                    )}
                  >
                    {t(KIND_LABEL[n.kind] ?? 'Notification')}
                  </span>
                  {!n.read_at && <span className="size-1.5 rounded-full bg-[#0081f2]" aria-hidden />}
                </span>
                <span className="truncate text-xs font-medium text-text-primary">{n.title}</span>
                <span className="line-clamp-2 text-[11px] leading-snug text-text-tertiary">{n.body}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end border-t border-border-main px-3 py-1.5">
            <span className="text-[10px] text-text-tertiary">{t('Devices')}</span>
            <button
              type="button"
              onClick={() => { setOpen(false); router.push('/app/computers'); }}
              className="ms-2 text-[11px] text-icon-blue hover:underline"
            >
              {t('Open computers')} <X className="inline size-2.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
