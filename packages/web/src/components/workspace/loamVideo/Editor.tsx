'use client';

import { lazy, Suspense, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { LOAM_VIDEO_STUDIO_PATH, type WorkspaceEditorProps } from '../types';
import { LoamVideoPanel, type LoamVideoBridgeStatus } from './LoamVideoPanel';

const LegacyVideoEditor = lazy(() => import('../video/Editor'));

/**
 * `loam-video` Workspace editor. Embeds the shared Loam Video studio; when the
 * vendored editor or its bridge is unavailable it falls back to the built-in
 * video editor with a short notice so manual editing still works.
 */
export function Editor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');
  const sourcePath = file.path === LOAM_VIDEO_STUDIO_PATH ? null : file.path;

  if (status === 'unavailable') {
    return (
      <div className="flex h-full flex-col gap-2 overflow-hidden bg-bg-menu">
        <div className="shrink-0 rounded-control bg-function-warning-tsp px-3 py-1.5 text-xs text-function-warning">
          {t('Loam Video is unavailable, so the built-in video editor is shown instead.')}
        </div>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-text-tertiary">
                <Loader2 className="size-4 animate-spin" /> {t('Loading')}
              </div>
            }
          >
            <LegacyVideoEditor file={file} live={live} onSave={onSave} onChatEdit={onChatEdit} />
          </Suspense>
        </div>
      </div>
    );
  }

  return <LoamVideoPanel taskId={file.taskId} sourcePath={sourcePath} onStatusChange={setStatus} />;
}

export default Editor;
