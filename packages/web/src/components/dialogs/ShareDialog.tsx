'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Check, X, Loader2, ShieldOff } from 'lucide-react';
import { t } from '@/i18n/t';
import { getLoamBase, getApiHeaders } from '@/services/rpc';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** Loam task id backing the share; null = nothing to share yet. */
  taskId: string | null;
}

interface ShareResponse {
  token: string;
  url: string;
  taskId: string;
  createdAt: string;
}

/**
 * Task share dialog (option #11): creates a public read-only link through
 * POST /api/tasks/:id/share, copies it, and can revoke it via
 * DELETE /api/shares/:token. Without a task id it falls back to copying the
 * current page URL.
 */
export function ShareDialog({ open, onClose, taskId }: ShareDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState(false);
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState(false);

  const createLink = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    setError('');
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getLoamBase()}/api/tasks/${encodeURIComponent(taskId)}/share`, { method: 'POST', headers });
      const data = (await res.json().catch(() => ({}))) as ShareResponse & { error?: string };
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      setShare(data);
      setRevoked(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const revokeLink = useCallback(async () => {
    if (!share) return;
    setLoading(true);
    setError('');
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getLoamBase()}/api/shares/${encodeURIComponent(share.token)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRevoked(true);
      setShare(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [share]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);

  useEffect(() => {
    if (open && taskId) void createLink();
    if (!open) {
      setCopied(false);
      setToast(false);
      setShare(null);
      setLoading(false);
      setError('');
      setRevoked(false);
    }
  }, [open, taskId, createLink]);

  if (!open) return null;

  const url = share?.url ?? (typeof window !== 'undefined' ? window.location.href : '');
  const canCopy = Boolean(share) || (!taskId && Boolean(url));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setToast(true);
      setTimeout(() => setCopied(false), 2000);
      setTimeout(() => setToast(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={t('Share')} tabIndex={-1}
        className="relative w-[420px] rounded-card bg-bg-menu p-6 shadow-menu outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title-lg text-text-primary">{t('Share')}</h2>
          <button type="button" aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 text-text-secondary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
        {!taskId ? (
          <p className="mb-3 text-sm text-text-secondary">{t('Send a message first — there is nothing to share yet.')}</p>
        ) : (
          <p className="mb-3 text-sm text-text-secondary">{t('Anyone with the link can view a read-only copy of this task.')}</p>
        )}
        {loading && (
          <div className="mb-3 flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Creating link…')}
          </div>
        )}
        {error && <div className="mb-3 rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">{error}</div>}
        {url && canCopy && (
          <div className="flex items-center gap-2 rounded-control border border-border-main bg-fill-tsp px-3 py-2">
            <Link2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
            <input
              readOnly
              value={url}
              className="flex-1 bg-transparent text-sm text-text-primary outline-none"
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {revoked && (
            <button
              type="button"
              onClick={() => void createLink()}
              className="inline-flex h-row items-center gap-1.5 rounded-control border border-border-main px-3 text-sm text-text-primary hover:bg-fill-hover"
            >
              <Link2 className="size-4" /> {t('Create link')}
            </button>
          )}
          {share && (
            <button
              type="button"
              onClick={() => void revokeLink()}
              className="inline-flex h-row items-center gap-1.5 rounded-control border border-border-main px-3 text-sm text-function-error hover:bg-fill-hover"
            >
              <ShieldOff className="size-4" /> {t('Revoke link')}
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            disabled={!canCopy}
            className="inline-flex h-row items-center gap-1.5 rounded-control bg-text-primary px-3 text-sm text-text-onblack hover:opacity-90 disabled:opacity-50"
          >
            {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
            {copied ? t('Copied') : t('Copy link')}
          </button>
        </div>
        {toast && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-control bg-function-success px-3 py-1.5 text-sm text-white shadow-menu">
            {t('Link copied')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
