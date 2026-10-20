'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, ImageIcon, FileVideo, Presentation, FileCode } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { kindFromName, type AttachmentKind } from '@/components/chat/AttachmentCard';
import { formatBytes } from '@/utils/format';

interface Creation {
  id: string;
  taskId: string;
  path: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  updatedAt: string;
}

const CREATION_KINDS: AttachmentKind[] = ['video', 'image', 'svg'];

function isCreationFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'mov', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
}

function iconForKind(kind: AttachmentKind) {
  if (kind === 'video') return <FileVideo className="size-8 text-text-tertiary" />;
  if (kind === 'svg') return <FileCode className="size-8 text-text-tertiary" />;
  if (kind === 'slide') return <Presentation className="size-8 text-text-tertiary" />;
  return <ImageIcon className="size-8 text-text-tertiary" />;
}

export default function CreationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Creation[]>([]);
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
        const taskIds = (tasks.tasks ?? []).map((t) => t.id);
        if (taskIds.length === 0) {
          if (mounted) setItems([]);
          return;
        }

        const collected: Creation[] = [];
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
                if (!isCreationFile(e.name)) continue;
                const kind = kindFromName(e.name);
                if (!CREATION_KINDS.includes(kind)) continue;
                collected.push({
                  id: `${taskId}:${e.path}`,
                  taskId,
                  path: e.path,
                  name: e.name,
                  kind,
                  size: e.size,
                  updatedAt: e.mtime ?? '',
                });
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('failed to list task files', taskId, e);
            }
          }),
        );

        collected.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (mounted) setItems(collected);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load creations', e);
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
        <h1 className="text-title-lg text-text-primary">{t('Creations')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load creations')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No creations yet.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Generated images, videos, and slides will appear here.')}</p>
          </div>
        ) : (
          <ul className="mx-auto grid w-full max-w-[1024px] grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((c) => (
              <li key={c.id} className="rounded-card border border-border-main bg-bg-menu p-3">
                <a
                  href={`${getApiBase()}/api/media?taskId=${encodeURIComponent(c.taskId)}&path=${encodeURIComponent(c.path)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <div className="mb-2 flex h-24 items-center justify-center rounded-control bg-fill-tsp">
                    {c.kind === 'image' || c.kind === 'svg' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${getApiBase()}/api/media?taskId=${encodeURIComponent(c.taskId)}&path=${encodeURIComponent(c.path)}`}
                        alt={c.name}
                        className="h-full w-full rounded-control object-cover"
                        loading="lazy"
                      />
                    ) : (
                      iconForKind(c.kind)
                    )}
                  </div>
                  <p className="truncate text-sm text-text-primary">{c.name}</p>
                  <p className="truncate text-xs text-text-tertiary">{formatBytes(c.size)}</p>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
