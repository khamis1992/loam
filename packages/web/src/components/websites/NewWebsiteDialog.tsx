'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { createAppProject, startRun, type AppProjectDto } from '@/services/appBuilderApi';
import { t } from '@/i18n/t';

const MIN_BRIEF = 10;

export function NewWebsiteDialog({ open, initialTitle, initialPrompt = '', onClose, onCreated }: {
  open: boolean;
  initialTitle?: string;
  initialPrompt?: string;
  onClose: () => void;
  onCreated: (project: AppProjectDto) => void;
}) {
  const [brief, setBrief] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AppProjectDto | null>(null);

  useEffect(() => {
    if (!open) return;
    setBrief(initialPrompt);
    setCreated(null);
    setError(null);
    setBusy(false);
  }, [open, initialPrompt, initialTitle]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const description = brief.trim();
    if (description.length < MIN_BRIEF || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = created ?? (await createAppProject(
        initialTitle?.trim() || description.split(/\r?\n/)[0]!.slice(0, 80),
        description,
        'goal',
      )).project;
      if (!created) {
        setCreated(project);
        onCreated(project);
      }
      await startRun(project.id, description, 'goal');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={t('New website')} width={560}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-text-secondary">{t('Describe your idea and Loam will design and build the website.')}</p>
        <label>
          <span className="sr-only">{t('Website description')}</span>
          <textarea
            autoFocus
            rows={6}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder={t('Describe the website you want to build')}
            className="w-full resize-y rounded-[10px] border border-border-main bg-bg-main p-3.5 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-dark"
          />
        </label>
        <div className="flex items-center justify-between gap-3 text-xs text-text-tertiary">
          <span>{brief.trim().length < MIN_BRIEF ? t('At least {count} characters.', { count: MIN_BRIEF }) : t('Ready to build')}</span>
          <span>{brief.trim().length}</span>
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-[8px] border border-func-error/20 bg-func-error/5 p-3 text-sm text-func-error">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-border-main pt-4">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-[7px] px-4 py-2 text-[13px] font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-50">
            {t('Cancel')}
          </button>
          <button
            type="submit"
            disabled={brief.trim().length < MIN_BRIEF || busy}
            className="flex items-center gap-2 rounded-[7px] bg-text-primary px-4 py-2 text-[13px] font-medium text-text-onblack hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {created ? t('Retry run') : t('Create website')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
