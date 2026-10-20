'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, ImageIcon, FileVideo, Presentation } from 'lucide-react';
import { t } from '@/i18n/t';
import { getLoamBase, getLoamAuthHeaders } from '@/services/rpc';

interface Creation {
  id: string;
  kind: 'image' | 'video' | 'slide' | string;
  title?: string;
  thumbnailUrl?: string;
}

export default function CreationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Creation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = getLoamAuthHeaders();
        const [creative, media]: [{ items?: Creation[] }, { items?: Creation[] }] = await Promise.all([
          fetch(`${getLoamBase()}/api/creative`, { headers }).then((r) => r.ok ? (r.json() as Promise<{ items?: Creation[] }>) : { items: [] }),
          fetch(`${getLoamBase()}/api/media`, { headers }).then((r) => r.ok ? (r.json() as Promise<{ items?: Creation[] }>) : { items: [] }),
        ]);
        const creativeItems = (creative.items ?? []).map((c: Creation) => ({ ...c, kind: c.kind || 'image' }));
        const mediaItems = (media.items ?? []).map((m: Creation) => ({ ...m, kind: m.kind || 'video' }));
        if (mounted) setItems([...creativeItems, ...mediaItems]);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('failed to load creations', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const iconFor = (kind?: string) => {
    if (kind === 'video') return <FileVideo className="size-5 text-text-tertiary" />;
    if (kind === 'slide') return <Presentation className="size-5 text-text-tertiary" />;
    return <ImageIcon className="size-5 text-text-tertiary" />;
  };

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
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No creations yet.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Generated images, videos, and slides will appear here.')}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((c) => (
              <li key={c.id} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="mb-2 flex h-24 items-center justify-center rounded-control bg-fill-tsp">
                  {c.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnailUrl} alt="" className="h-full w-full rounded-control object-cover" />
                  ) : (
                    iconFor(c.kind)
                  )}
                </div>
                <p className="truncate text-sm text-text-primary">{c.title || c.id}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
