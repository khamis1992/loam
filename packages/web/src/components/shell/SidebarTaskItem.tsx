'use client';

import { useState, useRef, useEffect } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useAppDispatch } from '@/store';
import { renameSession, deleteSession, loadSessions, type AgentSession } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import { getSessionToken, getApiBase, handleAuthFailure } from '@/services/rpc';
import clsx from 'clsx';

async function apiRename(uid: string, title: string) {
  const token = await getSessionToken();
  const res = await fetch(`${getApiBase()}/session.v1.SessionService/UpdateSession`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionUid: uid, title }),
  });
  if (res.status === 401) handleAuthFailure();
  if (!res.ok) throw new Error(`UpdateSession ${res.status}`);
}

async function apiDelete(uid: string) {
  const token = await getSessionToken();
  const res = await fetch(`${getApiBase()}/session.v1.SessionService/DeleteSession`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionUid: uid }),
  });
  if (res.status === 401) handleAuthFailure();
  if (!res.ok) throw new Error(`DeleteSession ${res.status}`);
}

export function SidebarTaskItem({ s, active, onClick }: { s: AgentSession; active: boolean; onClick: () => void }) {
  const dispatch = useAppDispatch();
  const running = s.status === 6;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(s.title);
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftTitle(s.title);
  }, [s.title]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && e.target !== rowRef.current) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  const saveRename = async () => {
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === s.title) {
      setDraftTitle(s.title);
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await apiRename(s.uid, trimmed);
      dispatch(renameSession({ uid: s.uid, title: trimmed }));
      dispatch(loadSessions());
    } catch {
      setDraftTitle(s.title);
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await apiDelete(s.uid);
      dispatch(deleteSession(s.uid));
      dispatch(loadSessions());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative">
      <button
        ref={rowRef}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'flex h-row-sm w-full items-center gap-2 rounded-row ps-1.5 pe-0.5 text-start text-sm',
          active ? 'bg-fill-hover text-text-primary' : 'text-text-secondary hover:bg-fill-hover',
        )}
      >
        <span aria-hidden className="w-4 shrink-0 text-center">{s.icon || '•'}</span>
        {editing ? (
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveRename();
              if (e.key === 'Escape') { setDraftTitle(s.title); setEditing(false); }
            }}
            autoFocus
            disabled={busy}
            className="flex-1 rounded bg-bg-menu px-1 text-sm text-text-primary outline-none ring-1 ring-border-main disabled:opacity-50"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate">{s.title || t('New task')}</span>
        )}
        {running && <span className="size-1.5 animate-pulse rounded-full bg-func-success" aria-label={t('Working')} />}
      </button>

      {!editing && (
        <button
          aria-label={t('More')}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className={clsx(
            'absolute end-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-fill-hover',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute end-1 top-7 z-20 w-36 rounded-card bg-bg-menu p-1 shadow-menu"
          role="menu"
          aria-label={t('More')}
        >
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setEditing(true); setDraftTitle(s.title); }}
            className="flex h-row-sm w-full items-center gap-2 rounded-row px-2 text-sm text-text-primary hover:bg-fill-hover"
          >
            <Pencil className="size-3.5" /> {t('Rename')}
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); void handleDelete(); }}
            className="flex h-row-sm w-full items-center gap-2 rounded-row px-2 text-sm text-func-error hover:bg-fill-hover disabled:opacity-50"
          >
            <Trash2 className="size-3.5" /> {t('Delete')}
          </button>
        </div>
      )}
    </div>
  );
}
