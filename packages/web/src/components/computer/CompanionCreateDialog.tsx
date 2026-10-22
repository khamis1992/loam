'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { createCompanion } from '@/services/companionsApi';

const LOAM_MODES = [
  { id: 'ask', labelAr: 'استكشف' },
  { id: 'research', labelAr: 'ابحث' },
  { id: 'build', labelAr: 'ابنِ' },
  { id: 'write', labelAr: 'اكتب' },
  { id: 'data', labelAr: 'حلّل' },
  { id: 'media', labelAr: 'صمّم' },
  { id: 'security', labelAr: 'افحص' },
  { id: 'automate', labelAr: 'أنجز' },
];

const EFFORT_LEVELS = [
  { id: 'max', labelAr: 'أقصى' },
  { id: 'high', labelAr: 'عالٍ' },
  { id: 'medium', labelAr: 'متوسط' },
  { id: 'low', labelAr: 'منخفض' },
];

interface CompanionCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CompanionCreateDialog({ open, onClose, onCreated }: CompanionCreateDialogProps) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('build');
  const [effort, setEffort] = useState('high');
  const [memory, setMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setEmoji('🤖');
    setDescription('');
    setMode('build');
    setEffort('high');
    setMemory(true);
    setError(null);
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('Name is required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCompanion({
        name: name.trim(),
        emoji: emoji.trim() || '🤖',
        description: description.trim(),
        mode,
        effort,
        workMode: memory ? 'loam' : 'chat',
      });
      reset();
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} title={t('Create companion')}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {t('Name')}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('Companion name')}
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {t('Companion emoji')}
          <input
            type="text"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {t('Description')}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('Companion description')}
            className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {t('Mode')}
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-sm text-text-primary"
          >
            {LOAM_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.labelAr}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {t('Effort')}
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-sm text-text-primary"
          >
            {EFFORT_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>{l.labelAr}</option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-3 hover:bg-fill-hover">
          <input
            type="checkbox"
            checked={memory}
            onChange={(e) => setMemory(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-text-primary"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">{t('Memory')}</p>
            <p className="text-xs text-text-tertiary">
              {memory ? t('Memory enabled (Loam execution)') : t('Memory disabled (Chat only)')}
            </p>
          </div>
        </label>

        {error && <p className="text-xs text-func-error">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button type="button" variant="primary" loading={busy} disabled={busy || !name.trim()} onClick={() => void handleCreate()}>
            {t('Create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
