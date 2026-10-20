'use client';

import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';

interface StartFromFileCardProps {
  onFilesAdd: (files: File[]) => void;
}

export function StartFromFileCard({ onFilesAdd }: StartFromFileCardProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    onFilesAdd(Array.from(list));
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); add(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label={t('Start from a local file')}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      className={clsx(
        'flex h-[216px] flex-col cursor-pointer items-center justify-center rounded-card border border-dashed p-4 text-center transition-colors hover:bg-fill-hover',
        dragOver ? 'border-[#0081f2] dark:border-[#1a93fe] bg-[var(--fill-blue)]' : 'border-[#0081f2] dark:border-[#1a93fe]',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => { add(e.target.files); e.currentTarget.value = ''; }}
      />
      <FolderOpen className="mb-2 size-16 text-text-tertiary" />
      <p className="text-sm font-medium text-text-primary">{t('Start from a local file')}</p>
      <p className="text-xs text-text-tertiary">{t('Click or drag local files here')}</p>
    </div>
  );
}
