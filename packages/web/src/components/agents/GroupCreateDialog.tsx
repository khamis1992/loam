'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { AgentCardAgent } from './AgentCard';
import type { GroupChat } from './groupTypes';

interface GroupCreateDialogProps {
  open: boolean;
  agents: AgentCardAgent[];
  onClose: () => void;
  onCreated: (group: GroupChat) => void;
}

export function GroupCreateDialog({ open, agents, onClose, onCreated }: GroupCreateDialogProps) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSelected(new Set());
    setError(null);
    setSaving(false);
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('Group name is required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/groups`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ name: trimmed, memberIds: [...selected] }),
      });
      const data = (await res.json()) as { group?: GroupChat; error?: string };
      if (!res.ok || !data.group) throw new Error(data.error || `status ${res.status}`);
      onCreated(data.group);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('New group')}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          <span>{t('Group name')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('e.g. Triage team')}
            autoFocus
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-text-primary"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-sm text-text-secondary">{t('Members')}</span>
          <div className="max-h-[280px] overflow-y-auto rounded-card border border-border-main bg-bg-main p-1">
            {agents.length === 0 ? (
              <p className="px-2 py-3 text-xs text-text-tertiary">{t('No agents yet. Create an agent first.')}</p>
            ) : (
              agents.map((agent) => (
                <label
                  key={agent.id}
                  className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(agent.id)}
                    onChange={() => toggle(agent.id)}
                    className="size-4 accent-text-primary"
                  />
                  <span className="text-base">{agent.emoji || '🤖'}</span>
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                </label>
              ))
            )}
          </div>
          <p className="text-[11px] text-text-tertiary">
            {t('You can add or remove members later from the Members tab.')}
          </p>
        </div>

        {error && <p className="text-sm text-function-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void handleCreate()}>
            {t('Create group')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
