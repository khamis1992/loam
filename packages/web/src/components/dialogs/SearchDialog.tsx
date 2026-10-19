'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '@/store';
import { t } from '@/i18n/t';

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useAppSelector((s) => s.sessions.list);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);

  if (!open) return null;
  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={t('Search')} tabIndex={-1}
        className="flex h-[440px] w-[680px] flex-col overflow-hidden rounded-[20px] bg-bg-menu shadow-menu outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] items-center gap-3 px-4">
          <span aria-hidden className="text-text-tertiary">🔍</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search tasks...')}
            className="flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary"
            autoFocus
          />
        </div>
        <hr className="border-border-main" />
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">{t('No results')}</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((s) => (
                <li key={s.uid}
                >
                  <button className="flex h-[40px] w-full items-center gap-3 rounded-control px-3 hover:bg-fill-hover">
                    <span aria-hidden>💬</span>
                    <span className="flex-1 truncate text-sm text-text-primary">{s.title || t('New task')}</span>
                    <span className="text-xs text-text-tertiary">{s.lastMessageTime ? new Date(s.lastMessageTime).toLocaleDateString() : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
