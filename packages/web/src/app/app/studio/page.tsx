'use client';

// NOTICE: Launcher layout (tool cards per studio kind opening the task workspace)
// follows the ARTCRAFT_ANALYSIS section 7 S-LAUNCHER design reference; original
// clean-room implementation, no ArtCraft brand or assets.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Video, FileText, Table2, Presentation as PresentationIcon, Palette,
  type LucideIcon,
} from 'lucide-react';
import { useAppDispatch } from '@/store';
import { addSession, loadSessions } from '@/store/sessionsSlice';
import { shortUid } from '@/utils/uid';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  STATIC_STUDIO_TOOLS, pickStudioTools,
  type StudioTool, type StudioToolKind,
} from '@/components/studio/studioTools';

const ICONS: Record<StudioToolKind, LucideIcon> = {
  video: Video,
  document: FileText,
  spreadsheet: Table2,
  presentation: PresentationIcon,
  design: Palette,
};

export default function StudioPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [tools, setTools] = useState<StudioTool[]>(STATIC_STUDIO_TOOLS);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/studio`, { headers: await getApiHeaders() });
        if (!res.ok) return;
        const listed = pickStudioTools(await res.json());
        if (mounted && listed) setTools(listed);
      } catch {
        // Offline or the route serves per-task artifacts: keep the static list.
      }
    })();
    return () => { mounted = false; };
  }, []);

  const openWorkspace = (tool: StudioTool) => {
    const uid = shortUid();
    const prompt = t(tool.prompt);
    dispatch(addSession({
      uid,
      title: prompt.slice(0, 60),
      status: 6,
      lastMessageTime: Date.now(),
      lastDisplayMessage: prompt,
      icon: '•',
    }));
    dispatch(loadSessions());
    const params = new URLSearchParams();
    params.set('draft', prompt);
    params.set('mode', 'standard');
    params.set('extData', JSON.stringify({ loamMode: tool.loamMode }));
    router.push(`/app/${uid}/?${params.toString()}`);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <h1 className="text-title-lg text-text-primary">{t('Studio')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="mx-auto grid w-full max-w-[960px] grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {tools.map((tool) => {
            const Icon = ICONS[tool.kind];
            return (
              <li key={tool.id}>
                <button
                  type="button"
                  onClick={() => openWorkspace(tool)}
                  className="flex h-full w-full flex-col items-start gap-2 rounded-card border border-border-main bg-bg-menu p-4 text-start hover:bg-fill-hover"
                >
                  <span className="flex size-9 items-center justify-center rounded-control bg-fill-tsp">
                    <Icon className="size-4 text-text-primary" aria-hidden />
                  </span>
                  <span className="text-sm font-medium text-text-primary">{t(tool.label)}</span>
                  <span className="text-xs text-text-tertiary">{t(tool.subtitle)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-center text-xs text-text-tertiary">
          {t('Each tool opens a new task workspace in its mode.')}
        </p>
      </div>
    </div>
  );
}
