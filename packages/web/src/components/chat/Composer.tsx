import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import {
  ArrowUp, Plus, ShieldCheck, Laptop, FolderGit, Folder, GitBranch, Square, X, ChevronDown,
  Mic, Github, Mail, Calendar,
} from 'lucide-react';
import { VoiceIcon } from '@/components/home/VoiceIcon';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { IconButton } from '@/components/ui/Button';
import { desktopApis } from '@/services/desktopApis';
import type { TaskMode } from '@shared/socket';

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  setFiles: (files: File[]) => void;
  addFiles: (files: File[]) => void;
}

interface ComposerProps {
  onSend: (text: string, mode: TaskMode, files: File[]) => void | Promise<void>;
  onStop?: () => void;
  running?: boolean;
  home?: boolean;
  onAddFolder?: (path: string) => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, onStop, running, home, onAddFolder }: ComposerProps,
  ref: Ref<ComposerHandle>,
) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TaskMode>('standard');
  const [files, setFiles] = useState<File[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canSend = text.trim().length > 0 || files.length > 0;

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setText: (v) => setText(v),
    setFiles: (v) => setFiles(v),
    addFiles: (incoming) => setFiles((prev) => [...prev, ...incoming]),
  }));

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const submit = async () => {
    if (!canSend) return;
    await onSend(text.trim(), mode, files);
    setText('');
    setFiles([]);
    setMenuOpen(false);
  };

  const onKey = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      await submit();
    }
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((prev) => [...prev, ...Array.from(incoming)]);
  };

  const removeFile = (target: File) => {
    setFiles((prev) => prev.filter((f) => f !== target));
  };

  const chooseFolder = async () => {
    setMenuOpen(false);
    try {
      const res = await desktopApis.system.showFolderDialog();
      if (res && typeof res === 'object' && 'path' in res && typeof (res as { path?: unknown }).path === 'string') {
        onAddFolder?.((res as { path: string }).path);
      }
    } catch {
      // ignore
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={clsx(
        'rounded-composer bg-bg-menu p-3 border border-[#e5e7eb] dark:border-white/[0.08] shadow-card transition-colors',
        dragOver && 'border-[#0081f2] dark:border-[#1a93fe] bg-[var(--fill-blue)]',
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={home ? 1 : 1}
        placeholder={t(files.length ? 'Tell {product} what to do with the file'
          : home ? 'Assign a task or type / for more'
          : 'Message {product}')}
        className="chat-input-editor w-full resize-none bg-transparent text-base leading-snug text-text-primary outline-none placeholder:text-text-disable"
      />
      {files.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li
              key={`${f.name}-${f.lastModified}`}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-fill-tsp px-2 py-1 text-xs"
            >
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f)}
                aria-label={t('Remove file')}
                title={t('Remove file')}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        {home ? (
          <div className="relative flex items-center gap-1" ref={menuRef}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover"
              aria-label={t('Add files')}
              title={t('Add files')}
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="hidden h-6 w-6 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover sm:flex"
              aria-label={t('Add files and more')}
              title={t('Add files and more')}
            >
              <ChevronDown className="size-3" />
            </button>
            {menuOpen && (
              <div className="absolute bottom-full start-0 z-50 mb-1 min-w-[160px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => { fileRef.current?.click(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Folder className="size-4" />
                  {t('Add files')}
                </button>
                <button
                  type="button"
                  onClick={chooseFolder}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <FolderGit className="size-4" />
                  {t('Add folder')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="relative flex items-center gap-1" ref={menuRef}>
            <IconButton label={t('Add files')} onClick={() => fileRef.current?.click()}>
              <Plus className="size-4" />
            </IconButton>
            <IconButton
              label={t('Add files and more')}
              onClick={() => setMenuOpen((v) => !v)}
              className="hidden sm:flex"
            >
              <Plus className="size-4" />
              <ChevronDown className="size-3" />
            </IconButton>
            {menuOpen && (
              <div className="absolute bottom-full start-0 z-50 mb-1 min-w-[160px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => { fileRef.current?.click(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Folder className="size-4" />
                  {t('Add files')}
                </button>
                <button
                  type="button"
                  onClick={chooseFolder}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <FolderGit className="size-4" />
                  {t('Add folder')}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="hidden items-center -space-x-1 rounded-full border border-border-main bg-bg-menu px-2 py-1 sm:flex">
          <span className="z-30 flex size-5 items-center justify-center rounded-full border border-white bg-black text-white dark:border-[#1f1f1f]"
            title={t('Github')}
          >
            <Github className="size-3" />
          </span>
          <span className="z-20 flex size-5 items-center justify-center rounded-full border border-white bg-[#ea4335] text-white dark:border-[#1f1f1f]"
            title={t('Gmail')}
          >
            <Mail className="size-3" />
          </span>
          <span className="z-10 flex size-5 items-center justify-center rounded-full border border-white bg-[#4285f4] text-white dark:border-[#1f1f1f]"
            title={t('Google Calendar')}
          >
            <Calendar className="size-3" />
          </span>
          <span className="ms-1 text-[11px] font-medium text-text-secondary">+4</span>
        </div>

        <button
          type="button"
          className="hidden items-center gap-1 rounded-full border border-border-main px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover sm:flex"
        >
          <ShieldCheck className="size-3.5" /> {t('Approve for me')}
        </button>

        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as TaskMode)}
          className="h-row-sm rounded-control bg-transparent px-2 text-sm text-text-secondary outline-none"
        >
          <option value="standard">{t('Standard')}</option>
          <option value="lite">{t('Lite')}</option>
          <option value="max">{t('Max')}</option>
        </select>

        {!home && (
          <span className="ms-2 flex items-center gap-1 text-xs text-text-secondary">
            <Laptop className="size-3.5" /> {t('This PC')}
          </span>
        )}

        <div className="flex-1" />

        {home && (
          <>
            <button
              type="button"
              className="hidden h-8 w-8 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover sm:flex"
              aria-label={t('Voice mode')}
              title={t('Voice mode')}
            >
              <VoiceIcon className="size-4" />
            </button>
            <button
              type="button"
              className="hidden h-8 w-8 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover sm:flex"
              aria-label={t('Microphone')}
              title={t('Microphone')}
            >
              <Mic className="size-4" />
            </button>
          </>
        )}

        {running
          ? (
            <IconButton
              label={t('Stop')}
              onClick={onStop}
              className="rounded-full bg-text-primary text-text-onblack hover:opacity-90"
            >
              <Square className="size-4 fill-current" />
            </IconButton>
          )
          : (
            <IconButton
              label={t('Send')}
              disabled={!canSend}
              onClick={submit}
              className={clsx(
                'rounded-full',
                canSend ? 'bg-text-primary text-text-onblack hover:opacity-90' : 'bg-fill-tsp text-text-secondary',
              )}
            >
              <ArrowUp className="size-4" />
            </IconButton>
          )}
      </div>
    </div>
  );
});

interface ComposerContextBarProps {
  home?: boolean;
  projectPath?: string | null;
  activeFolder?: 'project' | 'downloads' | null;
  onChooseProject?: () => void;
  onSelectDownloads?: () => void;
  branch?: string;
}

function basename(p?: string | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

function truncateBranch(b: string): string {
  if (b.length <= 24) return b;
  return b.slice(0, 22) + '…';
}

export function ComposerContextBar({
  home,
  projectPath,
  activeFolder,
  onChooseProject,
  onSelectDownloads,
  branch,
}: ComposerContextBarProps) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
      <span className="flex items-center gap-1">
        <Laptop className="size-3.5" /> {t('This PC')}
      </span>
      <button
        type="button"
        onClick={onChooseProject}
        className={clsx(
          'flex items-center gap-1 rounded-control px-1 transition-colors hover:bg-fill-hover',
          activeFolder === 'project' && 'bg-fill-hover text-text-primary',
        )}
      >
        <FolderGit className="size-3.5" />
        {projectPath ? basename(projectPath) : t('Choose project')}
      </button>
      <button
        type="button"
        onClick={onSelectDownloads}
        className={clsx(
          'flex items-center gap-1 rounded-control px-1 transition-colors hover:bg-fill-hover',
          activeFolder === 'downloads' && 'bg-fill-hover text-text-primary',
        )}
      >
        <Folder className="size-3.5" /> {t('Downloads')}
      </button>
      {branch && (
        <span className="flex max-w-[180px] items-center gap-1 truncate"
          title={branch}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{truncateBranch(branch)}</span>
        </span>
      )}
      <label className="flex cursor-not-allowed items-center gap-1 text-text-disable">
        <input type="checkbox" disabled className="size-3.5" /> {t('Worktree')}
      </label>
    </div>
  );
}
