'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import {
  getNotificationsServerSnapshot,
  getNotificationsSnapshot,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotifications,
  unreadCount,
  type NotificationItem,
} from './notificationsStore';

const KIND_LABEL: Record<string, string> = {
  'task-done': 'Completed',
  'task-failed': 'Failed',
  'approval-pending': 'Approval',
  'schedule-failed': 'Routine',
};

const KIND_CHIP: Record<string, string> = {
  'task-done': 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  'task-failed': 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  'approval-pending': 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  'schedule-failed': 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
};

/** Sidebar bell (option #20): unread dot over a client-side notification feed (stub seed). */
export function NotificationBell() {
  const router = useRouter();
  const items = useSyncExternalStore(subscribeNotifications, getNotificationsSnapshot, getNotificationsServerSnapshot);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = unreadCount(items);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n: NotificationItem) => {
    setOpen(false);
    markNotificationRead(n.id);
    if (n.task_id) router.push(`/app/${n.task_id}`);
  };

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        aria-label={t('Notifications')}
        title={t('Notifications')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'relative flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover',
          open && 'bg-fill-hover text-text-primary',
        )}
      >
        <Bell className="size-4" aria-hidden />
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
          className="absolute bottom-full end-0 z-50 mb-2 flex max-h-[420px] w-[300px] flex-col overflow-hidden rounded-card border border-border-main bg-bg-menu shadow-menu"
        >
          <div className="flex items-center justify-between border-b border-border-main px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">{t('Notifications')}</span>
            <button
              type="button"
              onClick={() => markAllNotificationsRead()}
              disabled={unread === 0}
              className="flex items-center gap-1 text-[11px] text-[color:var(--icon-blue)] disabled:opacity-40"
            >
              <CheckCheck className="size-3" aria-hidden />
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
                onClick={() => openItem(n)}
                className={clsx(
                  'flex w-full flex-col gap-0.5 rounded-control px-2 py-2 text-start hover:bg-fill-hover',
                  !n.read_at && 'bg-fill-tsp',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className={clsx('rounded px-1 text-[10px] font-medium', KIND_CHIP[n.kind])}>
                    {t(KIND_LABEL[n.kind] ?? 'Notification')}
                  </span>
                  {!n.read_at && <span className="size-1.5 rounded-full bg-[#0081f2]" aria-hidden />}
                </span>
                <span className="truncate text-xs font-medium text-text-primary">{n.title}</span>
                {n.body && <span className="line-clamp-2 text-[11px] leading-snug text-text-tertiary">{n.body}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
