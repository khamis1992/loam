'use client';

import { useState } from 'react';
import { MessageCircleQuestion, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface SentQuestion {
  taskId: string;
  question: string;
  readOnly: boolean;
}

interface SideChatPanelProps {
  /** Main task id; the side-chat question is answered as a separate read-only run. */
  taskId: string | null;
}

/**
 * Side-chat panel ("/btw question"). Sends a read-only question to the server,
 * which answers it in its own run so the main task keeps going. The server
 * restricts that run to inspection tools only.
 */
export function SideChatPanel({ taskId }: SideChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<SentQuestion[]>([]);

  async function send() {
    const q = question.trim();
    if (!q || !taskId || busy) return;
    setBusy(true);
    setError('');
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/btw`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json()) as { taskId?: string; sideChat?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      setSent((prev) => [...prev, { taskId: String(data.taskId ?? ''), question: q, readOnly: data.sideChat === true }]);
      setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border-main">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-row-sm w-full items-center gap-2 px-4 text-sm text-text-secondary hover:bg-fill-hover"
      >
        <MessageCircleQuestion className="size-4" />
        {t('Ask a side question (/btw)')}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
              placeholder="/btw what changed in src/index.ts?"
              aria-label={t('Side question')}
              disabled={!taskId || busy}
              className="h-8 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-sm text-text-primary outline-none focus:border-icon-blue"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!taskId || busy || !question.trim()}
              className="flex h-8 items-center gap-1 rounded-control bg-icon-blue px-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('Send')}
            </button>
          </div>
          {error && <div className="text-xs text-function-error">{error}</div>}
          {sent.length > 0 && (
            <ul className="flex flex-col gap-1">
              {sent.map((s) => (
                <li key={s.taskId} className="flex items-center gap-2 text-xs text-text-tertiary">
                  <span className="truncate">{s.question}</span>
                  <span className="ms-auto shrink-0">{s.readOnly ? t('read-only') : t('sent')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
