'use client';

import { useRef, useState } from 'react';
import { FolderOpen, Copy, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { desktopApis, isDesktop } from '@/services/desktopApis';

export type LocalFileSelection = { mode: 'copy' } | { mode: 'edit'; localFiles: string[] };

interface StartFromFileCardProps {
  onFilesAdd: (files: File[], selection: LocalFileSelection) => void;
}

export function StartFromFileCard({ onFilesAdd }: StartFromFileCardProps) {
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    if (files.length > 100) {
      setError(t('Choose up to 100 files at a time'));
      return;
    }
    setError('');
    setPending(files);
  };

  const copy = () => {
    onFilesAdd(pending, { mode: 'copy' });
    setPending([]);
  };

  const edit = async () => {
    if (!isDesktop()) {
      setError(t('Edit in place is available in the desktop app. Use a safe task copy instead.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const localFiles = await desktopApis.system.showOpenFileDialog({ multiple: true });
      if (localFiles && localFiles.length > 0) {
        if (localFiles.length > 100) throw new Error(t('Choose up to 100 files at a time'));
        onFilesAdd([], { mode: 'edit', localFiles });
        setPending([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); add(event.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={t('Start from a local file')}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
        className={clsx(
          'flex h-full min-h-[218px] flex-col cursor-pointer items-center justify-center rounded-card border border-transparent bg-fill-tsp p-4 text-center transition-colors hover:bg-fill-hover',
          dragOver && 'border-icon-blue bg-[var(--fill-blue)]',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => { add(event.target.files); event.currentTarget.value = ''; }}
        />
        <FolderOpen className="mb-2 size-16 text-text-tertiary opacity-40" strokeWidth={1.2} />
        <p className="text-sm font-medium text-text-primary">{t('Start from a local file')}</p>
        <p className="text-xs text-text-tertiary">{t('Click or drag local files here')}</p>
      </div>

      {pending.length > 0 && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/10 p-4" role="dialog" aria-modal="true" aria-label={t('Choose how to use local files')} onMouseDown={() => setPending([])}>
          <section className="w-full max-w-md rounded-[20px] border border-border-main bg-bg-menu p-5 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">{t('Choose how to use local files')}</h2>
                <p className="mt-1 text-xs text-text-tertiary">{t('A safe task copy is the default. Edit in place creates a backup before every write.')}</p>
              </div>
              <button type="button" aria-label={t('Close')} onClick={() => setPending([])} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><X className="size-4" /></button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" data-testid="local-copy-to-task" onClick={copy} className="rounded-card border border-icon-blue bg-fill-tsp p-4 text-start hover:bg-fill-hover">
                <Copy className="mb-3 size-5 text-icon-blue" />
                <span className="block text-sm font-medium text-text-primary">{t('Copy to task')}</span>
                <span className="mt-1 block text-xs text-text-tertiary">{t('Keep originals unchanged')}</span>
              </button>
              <button type="button" data-testid="local-edit-in-place" disabled={busy} onClick={() => void edit()} className="rounded-card border border-border-main p-4 text-start hover:bg-fill-hover disabled:opacity-50">
                <Pencil className="mb-3 size-5 text-text-secondary" />
                <span className="block text-sm font-medium text-text-primary">{t('Edit in place')}</span>
                <span className="mt-1 block text-xs text-text-tertiary">{t('Select files and keep backups')}</span>
              </button>
            </div>
            {error && <p role="alert" className="mt-3 text-xs text-text-danger">{error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
