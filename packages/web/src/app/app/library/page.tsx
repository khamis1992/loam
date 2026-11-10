'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AudioLines,
  File,
  FileText,
  Gamepad2,
  Globe2,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  Presentation,
  Search,
  SlidersHorizontal,
  Smartphone,
  Table2,
  Video,
} from 'lucide-react';
import clsx from 'clsx';
import { getLocale, t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { kindFromName, mediaUrl, type AttachmentKind } from '@/components/chat/AttachmentCard';
import { formatBytes } from '@/utils/format';
import { isTaskId } from '@/utils/taskIds';

type LibraryCategory = 'all' | FileCategory;
type FileCategory = 'text' | 'websites' | 'slides' | 'games' | 'spreadsheets' | 'images' | 'videos' | 'audio' | 'mobile' | 'others';
type ViewMode = 'grid' | 'list';
type SortMode = 'newest' | 'oldest' | 'name';

interface LibraryFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  taskId: string;
  kind: AttachmentKind;
  category: FileCategory;
}

const CATEGORY_TABS: Array<{ id: LibraryCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text & PDF' },
  { id: 'websites', label: 'Websites' },
  { id: 'slides', label: 'Slides' },
  { id: 'games', label: 'Games' },
  { id: 'spreadsheets', label: 'Spreadsheets' },
  { id: 'images', label: 'Images' },
  { id: 'videos', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'mobile', label: 'Mobile apps' },
  { id: 'others', label: 'Others' },
];

function categoryFromName(name: string): FileCategory {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['docx', 'doc', 'pdf', 'txt', 'md', 'rtf', 'odt', 'epub'].includes(ext)) return 'text';
  if (['html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte'].includes(ext)) return 'websites';
  if (['pptx', 'ppt', 'key', 'odp'].includes(ext)) return 'slides';
  if (['love', 'pck', 'gb', 'gbc', 'gba', 'nes', 'n64', 'nds', 'rom'].includes(ext)) return 'games';
  if (['xlsx', 'xls', 'csv', 'ods', 'numbers'].includes(ext)) return 'spreadsheets';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'].includes(ext)) return 'images';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'videos';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  if (['apk', 'aab', 'ipa'].includes(ext)) return 'mobile';
  return 'others';
}

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  return new Intl.DateTimeFormat(getLocale() === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }).format(time);
}

function FileTypeIcon({ file, className }: { file: LibraryFile; className: string }) {
  const props = { className, 'aria-hidden': true } as const;
  switch (file.category) {
    case 'text': return <FileText {...props} />;
    case 'websites': return <Globe2 {...props} />;
    case 'slides': return <Presentation {...props} />;
    case 'games': return <Gamepad2 {...props} />;
    case 'spreadsheets': return <Table2 {...props} />;
    case 'images': return <ImageIcon {...props} />;
    case 'videos': return <Video {...props} />;
    case 'audio': return <AudioLines {...props} />;
    case 'mobile': return <Smartphone {...props} />;
    default: return <File {...props} />;
  }
}

function GridFile({ file }: { file: LibraryFile }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const href = mediaUrl(file.taskId, file.path);
  const date = formatDate(file.updatedAt);
  return (
    <li className="min-w-0 overflow-hidden rounded-[10px] border border-border-main bg-bg-menu transition-shadow hover:shadow-card">
      <a href={href} target="_blank" rel="noopener noreferrer" className="block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-icon-blue">
        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-border-light bg-fill-tsp">
          {(file.kind === 'image' || file.kind === 'svg') && !previewFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={href} alt="" loading="lazy" onError={() => setPreviewFailed(true)} className="h-full w-full object-cover" />
          ) : (
            <FileTypeIcon file={file} className="size-11 stroke-[1.25] text-text-tertiary" />
          )}
        </div>
        <div className="p-3">
          <p className="truncate text-[13px] font-medium text-text-primary" title={file.name}>{file.name}</p>
          <p className="mt-1 truncate text-xs text-text-tertiary">
            {formatBytes(file.size)}{date && ` · ${date}`}
          </p>
        </div>
      </a>
    </li>
  );
}

function ListFile({ file }: { file: LibraryFile }) {
  const date = formatDate(file.updatedAt);
  return (
    <li>
      <a
        href={mediaUrl(file.taskId, file.path)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-[8px] border border-transparent px-3 py-2.5 hover:border-border-main hover:bg-bg-menu focus:outline-none focus-visible:ring-2 focus-visible:ring-icon-blue"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[7px] bg-fill-tsp">
          <FileTypeIcon file={file} className="size-[18px] text-text-secondary" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-text-primary">{file.name}</span>
          <span className="mt-0.5 block truncate text-xs text-text-tertiary">{file.path}</span>
        </span>
        <span className="hidden shrink-0 text-xs text-text-tertiary sm:block">{formatBytes(file.size)}</span>
        <span className="hidden w-24 shrink-0 text-end text-xs text-text-tertiary md:block">{date}</span>
      </a>
    </li>
  );
}

export default function LibraryPage() {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<LibraryCategory>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const [view, setView] = useState<ViewMode>('grid');

  const loadFiles = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getApiHeaders();
      // One aggregate call lists every task's files, tagged with taskId.
      const params = new URLSearchParams({ list: '1', max: '400' });
      const res = await fetch(`${getApiBase()}/api/files?${params.toString()}`, { headers, signal });
      if (!res.ok) throw new Error(`files ${res.status}`);
      const data = (await res.json()) as {
        entries?: Array<{ taskId?: string; name: string; path: string; size: number; mtime?: string; dir?: boolean }>;
      };
      const collected: LibraryFile[] = [];
      for (const entry of data.entries ?? []) {
        if (entry.dir || typeof entry.taskId !== 'string' || !isTaskId(entry.taskId)) continue;
        collected.push({
          name: entry.name,
          path: entry.path,
          size: entry.size,
          updatedAt: entry.mtime ?? '',
          taskId: entry.taskId,
          kind: kindFromName(entry.name),
          category: categoryFromName(entry.name),
        });
      }
      if (!signal?.aborted) setFiles(collected);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.error('failed to load library', e);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(controller.signal);
    return () => controller.abort();
  }, [loadFiles]);

  const visibleFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return files
      .filter((file) => category === 'all' || file.category === category)
      .filter((file) => !normalizedQuery || `${file.name} ${file.path}`.toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const direction = sort === 'newest' ? -1 : 1;
        return direction * a.updatedAt.localeCompare(b.updatedAt);
      });
  }, [files, category, query, sort]);

  const emptyMessage = query
    ? t('No files match your search.')
    : category !== 'all'
      ? t('No files in this category.')
      : t('No files in library.');

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
      <header className="flex min-h-14 shrink-0 flex-col gap-3 px-6 py-3 sm:h-14 sm:flex-row sm:items-center sm:justify-between sm:py-0">
        <h1 className="shrink-0 text-[18px] font-semibold tracking-[-0.01em] text-text-primary">{t('Library')}</h1>
        <div className="flex items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-border-main bg-bg-menu px-2.5 text-text-secondary focus-within:border-border-dark sm:w-60 sm:flex-none">
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="sr-only">{t('Search files')}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search files')}
              aria-label={t('Search files')}
              className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </label>
          <label className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-border-main bg-bg-menu text-text-secondary hover:bg-fill-hover focus-within:ring-2 focus-within:ring-icon-blue">
            <SlidersHorizontal className="size-4" aria-hidden />
            <span className="sr-only">{t('Sort files')}</span>
            <select
              aria-label={t('Sort files')}
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            >
              <option value="newest">{t('Newest first')}</option>
              <option value="oldest">{t('Oldest first')}</option>
              <option value="name">{t('Name A–Z')}</option>
            </select>
          </label>
          <div className="flex shrink-0 items-center rounded-[6px] bg-fill-tsp p-0.5" role="group" aria-label={t('View options')}>
            <button
              type="button"
              aria-label={t('Grid view')}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
              className={clsx(
                'flex size-7 items-center justify-center rounded-[5px]',
                view === 'grid' ? 'bg-bg-menu text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              <LayoutGrid className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t('List view')}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className={clsx(
                'flex size-7 items-center justify-center rounded-[5px]',
                view === 'list' ? 'bg-bg-menu text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              <List className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </header>

      <nav aria-label={t('Library categories')} className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto px-6">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={category === tab.id}
            onClick={() => setCategory(tab.id)}
            className={clsx(
              'shrink-0 rounded-[6px] px-3 py-2 text-[13px] transition-colors',
              category === tab.id ? 'bg-fill-hover font-medium text-text-primary' : 'text-text-secondary hover:bg-fill-tsp hover:text-text-primary',
            )}
          >
            {t(tab.label)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-2" aria-live="polite">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="size-5 animate-spin" aria-hidden /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-4 pt-8 text-center" role="alert">
            <AlertCircle className="size-5 text-func-error" aria-hidden />
            <div>
              <p className="text-sm text-text-primary">{t('Failed to load library')}</p>
              <p className="mt-1 text-xs text-text-tertiary">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void loadFiles()}
              className="rounded-[7px] bg-fill-hover px-4 py-2 text-xs font-medium text-text-primary hover:bg-fill-tsp"
            >
              {t('Retry')}
            </button>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center text-text-tertiary">
            <File className="mb-2 size-8 stroke-[1.25]" aria-hidden />
            <p className="text-sm text-text-secondary">{emptyMessage}</p>
            {!query && category === 'all' && (
              <p className="max-w-[360px] text-xs">{t('Task outputs and uploads will appear here once the backend indexes them.')}</p>
            )}
          </div>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4" data-testid="library-grid">
            {visibleFiles.map((file) => <GridFile key={`${file.taskId}:${file.path}`} file={file} />)}
          </ul>
        ) : (
          <ul className="flex flex-col" data-testid="library-list">
            {visibleFiles.map((file) => <ListFile key={`${file.taskId}:${file.path}`} file={file} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
