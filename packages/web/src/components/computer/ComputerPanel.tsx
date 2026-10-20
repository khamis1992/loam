'use client';

import { useEffect, useState } from 'react';
import type { ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { desktopApis, desktopEvents } from '@/services/desktopApis';

interface ComputerPanelProps {
  event: ToolUsedEvent | null;
  onClose: () => void;
}

export function ComputerPanel({ event, onClose }: ComputerPanelProps) {
  const [output, setOutput] = useState<string>('');

  useEffect(() => {
    setOutput('');
    if (!event) return;
    const detail = event.detail ?? event.argumentsDetail;
    if (!detail) return;
    if (event.tool === 'terminal') {
      const d = detail as { terminal?: { command?: string; output?: string[]; shellId?: string } };
      const command = d.terminal?.command ?? '';
      const lines = d.terminal?.output ?? [];
      const text = command ? [`$ ${command}`, ...lines] : lines;
      setOutput(text.join('\n'));
    } else if (event.tool === 'text_editor') {
      const d = detail as { textEditor?: { path?: string; content?: string; oldContent?: string } };
      setOutput(`${d.textEditor?.path ?? ''}\n---\n${d.textEditor?.content ?? ''}`);
    } else if (event.tool === 'search') {
      const d = detail as { search?: { queries?: string[]; results?: { title: string; link: string; snippet: string }[] } };
      const lines = [d.search?.queries?.join(', ') ?? ''];
      for (const r of d.search?.results ?? []) {
        lines.push(`${r.title}\n${r.link}\n${r.snippet}`);
      }
      setOutput(lines.join('\n\n'));
    } else if (event.tool === 'webpage_extract') {
      const d = detail as { webpageExtract?: { url?: string; markdown?: string } };
      setOutput(`${d.webpageExtract?.url ?? ''}\n---\n${d.webpageExtract?.markdown ?? ''}`);
    } else {
      setOutput(JSON.stringify(detail, null, 2));
    }
  }, [event]);

  useEffect(() => {
    const unsub = desktopEvents.terminal.onEvent((ev) => {
      if (ev.kind === 'output') setOutput((prev) => (prev ? prev + '\n' : '') + (ev.data ?? ''));
    });
    return unsub;
  }, []);

  if (!event) return null;

  return (
    <div className="flex h-full w-[360px] shrink-0 flex-col border-s border-border-main bg-bg-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-3">
        <span className="text-sm font-semibold text-text-primary">{t("Loam's computer")}</span>
        <button aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 hover:bg-fill-hover">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {output ? (
          <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">{output}</pre>
        ) : (
          <p className="text-sm text-text-tertiary">{t('No content')}</p>
        )}
      </div>
    </div>
  );
}
