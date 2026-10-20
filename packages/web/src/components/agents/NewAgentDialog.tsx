'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Spinner } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface AgentTemplate {
  id: string;
  labelAr: string;
  emoji: string;
  description: string;
  mode: string;
  workMode: string;
}

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function NewAgentDialog({ open, onClose, onCreated }: NewAgentDialogProps) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    setName('');
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agent-templates`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { templates?: AgentTemplate[] };
        if (mounted) setTemplates(data.templates ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [open]);

  const handleCreate = async () => {
    if (!selectedId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/from-template`, {
        method: 'POST',
        headers: {
          ...(await getApiHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateId: selectedId,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      onCreated();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('New agent from template')} width={520}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          {t('Name')} ({t('optional')})
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('Agent name')}
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
          />
        </label>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
            <Spinner className="size-5" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
            {error}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 max-h-[320px] overflow-y-auto">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setSelectedId(tpl.id)}
                className={`flex items-start gap-3 rounded-control border p-3 text-start transition-colors ${
                  selectedId === tpl.id
                    ? 'border-border-dark bg-fill-hover'
                    : 'border-border-main bg-bg-main hover:bg-fill-hover'
                }`}
              >
                <span className="text-xl">{tpl.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{tpl.labelAr}</p>
                  <p className="text-xs text-text-tertiary">{tpl.description}</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">{tpl.mode} · {tpl.workMode}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={creating}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={!selectedId || creating}
            onClick={handleCreate}
          >
            {t('Create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
