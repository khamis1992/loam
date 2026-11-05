'use client';

import { lazy, Suspense, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { LOAM_VIDEO_STUDIO_PATH, type WorkspaceEditorProps } from '../types';
import { LoamVideoPanel, type LoamVideoBridgeStatus } from './LoamVideoPanel';
import { VideoFilePreview } from './VideoFilePreview';

const LegacyVideoEditor = lazy(() => import('../video/Editor'));

export function Editor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');
  const [advanced, setAdvanced] = useState(false);
  const sourcePath = file.path === LOAM_VIDEO_STUDIO_PATH ? null : file.path;
  const legacy = (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center gap-2 text-sm text-text-tertiary">
          <Loader2 className="size-4 animate-spin" /> {t('Loading')}
        </div>
      }
    >
      <LegacyVideoEditor file={file} live={live} onSave={onSave} onChatEdit={onChatEdit} />
    </Suspense>
  );

  if (sourcePath && !advanced) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-bg-menu">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-main px-3 py-1.5">
          <span className="text-xs text-text-tertiary">{t('Preview the finished video, or open the advanced studio only when you need it.')}</span>
          <button type="button" data-testid="open-advanced-video-studio" onClick={() => setAdvanced(true)} className="flex h-row-sm shrink-0 items-center gap-1.5 rounded-control bg-fill-tsp px-2.5 text-xs text-text-primary hover:bg-fill-hover">
            <Wand2 className="size-3.5" /> {t('Open in Loam Video studio')}
          </button>
        </div>
        <div className="min-h-0 flex-1"><VideoFilePreview file={file} posterPath={file.path === 'uploads/presentation-video.mp4' ? 'previews/presentation-video.png' : undefined} /></div>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="flex h-full flex-col gap-2 overflow-hidden bg-bg-menu">
        <div className="shrink-0 rounded-control bg-function-warning-tsp px-3 py-1.5 text-xs text-function-warning">
          {t('Loam Video is unavailable, so the built-in video editor is shown instead.')}
        </div>
        <div className="min-h-0 flex-1">{legacy}</div>
      </div>
    );
  }

  return <LoamVideoPanel taskId={file.taskId} sourcePath={sourcePath} onStatusChange={setStatus} />;
}

export default Editor;
