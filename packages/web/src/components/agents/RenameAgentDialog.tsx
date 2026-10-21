'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { AgentCardAgent } from './AgentCard';

interface RenameAgentDialogProps {
  agent: AgentCardAgent | null;
  onClose: () => void;
  /** Called with the new display name after the server confirms the rename. */
  onRenamed: () => void;
}

export function RenameAgentDialog({ agent, onClose, onRenamed }: RenameAgentDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agent) setName(agent.name);
  }, [agent]);

  useEffect(() => {
    if (!agent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agent, onClose]);

  if (!agent) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === agent.name) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      onRenamed();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-[360px] flex-col gap-3 rounded-card border border-border-main bg-bg-menu p-4 shadow-menu">
        <div className="flex h-row items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">{t('Rename agent')}</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-row-sm w-row-sm px-0"
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X className="size-4" />
          </Button>
        </div>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
        />
        {error && <p className="text-xs text-function-error">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={saving}
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {t('Save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
