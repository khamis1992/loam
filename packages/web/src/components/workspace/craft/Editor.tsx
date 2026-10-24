'use client';

import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { CraftApp } from '@/lib/craftBridge';
import type { WorkspaceEditorProps } from '../types';
import { craftAppForExtension, craftAppForMime, craftExtOf } from '../craft';
import { CraftPanel, craftSaveMime } from './CraftPanel';

/**
 * The `craft` workspace editor (cr-03): every file type one of the Loam Craft apps
 * owns (Docs / Sheets / Slides / Photo / Design) routes here and mounts `CraftPanel`.
 * When the app dist is missing or its bridge never becomes ready, the panel falls
 * back to Loam's own doc/sheet/slides editor; Photo and Design show the media
 * preview. The workspace shell already renders the file name and close button, so
 * the panel renders without its own header (`hideHeader`).
 *
 * `onSave` (from the shell) is not wired here: `CraftPanel` owns the save path
 * (`craft:save` -> `/api/upload`), which is what cr-02's panel uses, so panel
 * exports and manual saves land in the same place.
 */
export function Editor({ file }: WorkspaceEditorProps) {
  const [app, setApp] = useState<CraftApp | null>(() => craftAppForExtension(craftExtOf(file.path)));

  // A `.docx` mislabelled `application/octet-stream` still opens in Loam Docs, so the
  // MIME type is only consulted when the extension does not resolve an app.
  useEffect(() => {
    if (craftAppForExtension(craftExtOf(file.path))) return;
    setApp(craftAppForMime(file.mime ?? ''));
  }, [file.mime, file.path]);

  // Store one `craft:save` payload in the task's files, the same endpoint cr-02's own
  // panel uses, so panel exports and manual saves land in the same place.
  const handleCraftSave = async (name: string, bytes: Uint8Array): Promise<void> => {
    const blob = new Blob([bytes as unknown as BlobPart], { type: craftSaveMime(name) });
    const params = new URLSearchParams({ taskId: file.taskId, name });
    const res = await fetch(`${getApiBase()}/api/upload?${params.toString()}`, {
      method: 'POST',
      headers: await getApiHeaders(),
      body: blob,
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `upload failed (${res.status})`);
    }
  };

  if (!app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-tertiary">
        <AlertCircle className="size-5" />
        <p>{t('This file type has no workspace editor yet.')}</p>
      </div>
    );
  }

  return (
    <CraftPanel
      taskId={file.taskId}
      app={app}
      path={file.path}
      onClose={() => undefined}
      hideHeader
      uploadBytes={(_taskId, name, bytes) => handleCraftSave(name, bytes)}
    />
  );
}

export default Editor;
