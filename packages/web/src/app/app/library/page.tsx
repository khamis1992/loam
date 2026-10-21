'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, FileText, ExternalLink } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { kindFromName, type AttachmentKind } from '@/components/chat/AttachmentCard';
import { formatBytes } from '@/utils/format';
import { isTaskId } from '@/utils/taskIds';

interface LibraryFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  taskId: string;
  kind: AttachmentKind;
}

function isLibraryFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['docx', 'doc', 'pdf', 'txt', 'md', 'pptx', 'ppt', 'xlsx', 'xls', 'csv'].includes(ext);
}

export default function LibraryPage() {
  const router = useRouter();
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const tasksRes = await fetch(`${getApiBase()}/api/tasks?limit=50`, { headers });
        if (!tasksRes.ok) throw new Error(`tasks ${tasksRes.status}`);
        const tasks = (await tasksRes.json()) as { tasks?: Array<{ id: string; updatedAt: string }> };
        const taskIds = (tasks.tasks ?? []).map((t) => t.id).filter(isTaskId);
        if (taskIds.length === 0) {
          if (mounted) setFiles([]);
          return;
        }

        const collected: LibraryFile[] = [];
        await Promise.all(
          taskIds.map(async (taskId) => {
            try {
              const params = new URLSearchParams({ taskId, path: '', max: '200' });
              const res = await fetch(`${getApiBase()}/api/files?${params.toString()}`, { headers });
              if (!res.ok) return;
              const data = (await res.json()) as {
                entries?: Array<{ name: string; path: string; size: number; mtime?: string; dir?: boolean }>;
              };
              for (const e of data.entries ?? []) {
                if (e.dir) continue;
                if (!isLibraryFile(e.name)) continue;
                collected.push({
                  name: e.name,
                  path: e.path,
                  size: e.size,
                  updatedAt: e.mtime ?? '',
                  taskId,
                  kind: kindFromName(e.name),
                });
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('failed to list task files', taskId, e);
            }
          }),
        );

        collected.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (mounted) setFiles(collected);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load library', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Library')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load library')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No files in library.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Task outputs and uploads will appear here once the backend indexes them.')}</p>
          </div>
        ) : (
          <ul className="mx-auto flex w-full max-w-[768px] flex-col gap-2">
            {files.map((f) => (
              <li key={`${f.taskId}:${f.path}`} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3 hover:bg-fill-hover">
                <FileText className="size-5 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{f.name}</p>
                  <p className="text-xs text-text-tertiary">
                    {f.path}
                    {f.size !== undefined && ` · ${formatBytes(f.size)}`}
                  </p>
                </div>
                <a
                  href={`${getApiBase()}/api/media?taskId=${encodeURIComponent(f.taskId)}&path=${encodeURIComponent(f.path)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-text-secondary hover:bg-fill-hover"
                >
                  <ExternalLink className="size-3.5" />
                  {t('Open')}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
