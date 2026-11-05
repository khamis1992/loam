'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { mediaUrl } from '@/components/chat/AttachmentCard';
import { getApiHeaders } from '@/services/rpc';
import type { WorkspaceFile } from '../types';

export function VideoFilePreview({ file, posterPath }: { file: WorkspaceFile; posterPath?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setError('');
    setUrl(null);
    void (async () => {
      try {
        const response = await fetch(mediaUrl(file.taskId, file.path), { headers: await getApiHeaders() });
        if (!response.ok) throw new Error(`${t('Video preview failed')} (${response.status})`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setUrl(objectUrl);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.taskId, file.path]);

  useEffect(() => {
    if (!posterPath) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(mediaUrl(file.taskId, posterPath), { headers: await getApiHeaders() });
        if (!response.ok) return;
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setPosterUrl(objectUrl);
      } catch {
        // The video remains playable when no poster exists.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.taskId, posterPath]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-white">
        <span className="truncate text-xs">{file.name}</span>
        {url && (
          <a href={url} download={file.name} className="flex items-center gap-1.5 rounded-control bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">
            <Download className="size-3.5" /> {t('Download')}
          </a>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {url ? (
          <video data-testid="finished-video-player" src={url} poster={posterUrl ?? undefined} controls preload="metadata" className="h-full max-h-full w-full object-contain" />
        ) : error ? (
          <p role="alert" className="p-6 text-sm text-red-300">{error}</p>
        ) : (
          <div className="flex items-center gap-2 text-sm text-white/60"><Loader2 className="size-4 animate-spin" /> {t('Loading')}</div>
        )}
      </div>
    </div>
  );
}

export default VideoFilePreview;
