import { useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp, Plus, Mic, ShieldCheck, Laptop, FolderGit, Folder, GitBranch, Square,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { IconButton } from '@/components/ui/Button';
import type { TaskMode } from '@shared/socket';

export function Composer({ onSend, onStop, running, home }: {
  onSend: (text: string, mode: TaskMode, files: File[]) => void;
  onStop?: () => void; running?: boolean; home?: boolean;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TaskMode>('standard');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = text.trim().length > 0 || files.length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), mode, files);
    setText(''); setFiles([]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };

  return (
    <div className="rounded-composer bg-bg-menu p-3 border border-[#e5e7eb] dark:border-white/[0.08] shadow-card">
      <textarea
        value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={home ? 3 : 1}
        placeholder={t(files.length ? 'Tell {product} what to do with the file'
          : home ? 'Assign a task or type / for more'
          : 'Message {product}')}
        className="chat-input-editor w-full resize-none bg-transparent text-base text-text-primary outline-none placeholder:text-text-disable"
      />
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f) => <li key={f.name} className="rounded-control bg-fill-tsp px-2 py-1 text-xs">{f.name}</li>)}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <IconButton label={t('Add files')} onClick={() => fileRef.current?.click()}><Plus className="size-4" /></IconButton>
        <input ref={fileRef} type="file" multiple hidden
          onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
        <select value={mode} onChange={(e) => setMode(e.target.value as TaskMode)}
          className="h-row-sm rounded-control bg-transparent px-2 text-sm text-text-secondary outline-none">
          <option value="standard">{t('Standard')}</option>
          <option value="lite">{t('Lite')}</option>
          <option value="max">{t('Max')}</option>
        </select>
        {!home && (
          <>
            <span className="ms-2 flex items-center gap-1 text-xs text-text-secondary">
              <ShieldCheck className="size-3.5" /> {t('Approve for me')}
            </span>
            <span className="ms-2 flex items-center gap-1 text-xs text-text-secondary">
              <Laptop className="size-3.5" /> {t('This PC')}
            </span>
          </>
        )}
        <div className="flex-1" />
        <IconButton label={t('Add files and more')} className="hidden"><span /></IconButton>
        <IconButton label={t('Add files and more')} onClick={() => {}} className="hidden sm:flex"><Mic className="size-4" /></IconButton>
        {running
          ? <IconButton label={t('Stop')} onClick={onStop} className="rounded-full bg-text-primary text-text-onblack hover:opacity-90"><Square className="size-4 fill-current" /></IconButton>
          : <IconButton label={t('Send')} disabled={!canSend} onClick={submit}
              className={clsx('rounded-full', canSend ? 'bg-text-primary text-text-onblack hover:opacity-90' : 'opacity-50')}>
              <ArrowUp className="size-4" />
            </IconButton>}
      </div>
    </div>
  );
}

export function ComposerContextBar({ home }: { home?: boolean }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
      <span className="flex items-center gap-1"><Laptop className="size-3.5" /> {t('This PC')}</span>
      <span className="flex items-center gap-1"><FolderGit className="size-3.5" /> {t('Choose project')}</span>
      <span className="flex items-center gap-1"><Folder className="size-3.5" /> Downloads</span>
      <span className="flex items-center gap-1"><GitBranch className="size-3.5" /> main</span>
      {!home && <label className="flex items-center gap-1"><input type="checkbox" className="size-3.5" /> {t('Worktree')}</label>}
    </div>
  );
}
