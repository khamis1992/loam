'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Search, MessageSquare } from 'lucide-react';
import { useAppSelector } from '@/store';
import { t } from '@/i18n/t';

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useAppSelector((s) => s.sessions.list);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title || '').toLowerCase().includes(q));
  }, [sessions, query]);

  useEffect(() => {
    setHighlighted(0);
  }, [filtered.length, query]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const s = filtered[highlighted];
        if (s) {
          onClose();
          router.push(`/app/${s.uid}`);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose, filtered, highlighted, router]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={t('Search')} tabIndex={-1}
        className="flex h-[440px] w-[680px] flex-col overflow-hidden rounded-[20px] bg-bg-menu shadow-menu outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] items-center gap-3 px-4">
          <Search className="size-5 text-text-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search tasks...')}
            className="flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <hr className="border-border-main" />
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-tertiary">{t('No results')}</div>
          ) : (
            <ul className="flex flex-col gap-1" role="listbox">
              {filtered.map((s, idx) => (
                <li key={s.uid} role="option" aria-selected={idx === highlighted}>
                  <button
                    onMouseEnter={() => setHighlighted(idx)}
                    onClick={() => { onClose(); router.push(`/app/${s.uid}`); }}
                    className={`
                      flex h-[40px] w-full items-center gap-3 rounded-control px-3
                      ${idx === highlighted ? 'bg-fill-hover' : 'hover:bg-fill-hover'}
                    `}
                  >
                    <MessageSquare className="size-4 text-text-tertiary" aria-hidden />
                    <span className="flex-1 truncate text-sm text-text-primary">{s.title || t('New task')}</span>
                    <span className="text-xs text-text-tertiary">
                      {s.lastMessageTime ? new Date(s.lastMessageTime).toLocaleDateString() : ''}
                    </span>
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
