'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Monitor, Play, Square } from 'lucide-react';
import type { WorkspaceEditorProps } from '../types';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { t } from '@/i18n/t';

interface DesktopProject {
  id: string;
  title: string;
  kind: string;
}

export default function DesktopEditor({ file }: WorkspaceEditorProps) {
  const [project, setProject] = useState<DesktopProject | null>(null);
  const [verified, setVerified] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const response = await fetch(`${getApiBase()}/api/desktop/metadata?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`, { headers: await getApiHeaders() });
    const data = await response.json() as { project?: DesktopProject; verified?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error ?? t('Failed to load the desktop project.'));
    if (data.project) setProject(data.project);
    setVerified(Boolean(data.verified));
  }, [file.path, file.taskId]);

  useEffect(() => { void load().catch((reason: Error) => setError(reason.message)); }, [load]);

  const action = async (name: 'launch' | 'stop') => {
    if (!project) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${getApiBase()}/api/desktop/${name}`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t('Desktop action failed'));
      setRunning(name === 'launch');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-[#f7f8f5] p-8 text-center">
      <div className="grid size-16 place-items-center rounded-[20px] bg-[#187665] text-white"><Monitor className="size-8" /></div>
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{project?.title ?? file.name}</h2>
        <p className="mt-2 text-sm text-text-tertiary">{t('A real Electron desktop app running locally on this PC.')}</p>
      </div>
      <div className="flex items-center gap-2 text-xs">
        {verified ? <span className="flex items-center gap-1 text-[#187665]"><CheckCircle2 className="size-4" />{t('Build and smoke test passed')}</span> : <span className="text-text-tertiary">{t('Verification required')}</span>}
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !verified || running} onClick={() => void action('launch')} className="flex items-center gap-2 rounded-control bg-[#187665] px-4 py-2 text-sm text-white disabled:opacity-45">
          <Play className="size-4" />{t('Open desktop app')}
        </button>
        <button type="button" disabled={busy || !running} onClick={() => void action('stop')} className="flex items-center gap-2 rounded-control border border-border-main px-4 py-2 text-sm text-text-primary disabled:opacity-45">
          <Square className="size-4" />{t('Stop app')}
        </button>
      </div>
      {error && <p className="flex max-w-md items-start gap-2 text-start text-sm text-function-error"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
    </div>
  );
}
