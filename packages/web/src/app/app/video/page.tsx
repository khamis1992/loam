'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clapperboard, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import type { FilmcraftBridge } from '@/lib/filmcraft';
import {
  LoamVideoPanel,
  type LoamVideoBridgeStatus,
} from '@/components/workspace/loamVideo/LoamVideoPanel';

export default function VideoPage() {
  const router = useRouter();
  const bridgeRef = useRef<FilmcraftBridge | null>(null);
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const runAction = async (label: string, action: (bridge: FilmcraftBridge) => Promise<unknown>) => {
    const bridge = bridgeRef.current;
    if (!bridge || status !== 'ready') return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await action(bridge);
      setMessage(`${label}: ${summarize(result)}`);
    } catch (e) {
      setMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const ready = status === 'ready';

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="flex flex-1 items-center gap-2 text-title-lg text-text-primary">
          <Clapperboard className="size-5" /> {t('Loam Video')}
        </h1>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            status === 'ready'
              ? 'bg-fill-tsp text-text-secondary'
              : status === 'unavailable'
                ? 'bg-function-error-tsp text-function-error'
                : 'bg-fill-tsp text-text-tertiary'
          }`}
        >
          {status === 'loading' && <Loader2 className="mr-1 inline size-3 animate-spin" />}
          {status === 'ready' ? t('Ready') : status === 'unavailable' ? t('Unavailable') : t('Loading')}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border-main px-4 py-2">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void runAction(t('New project'), (bridge) => bridge.newProject())}
          className="flex h-row-sm items-center gap-1.5 rounded-control bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-50"
        >
          {t('New project')}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://"
            className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2.5 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <button
            type="button"
            disabled={!ready || busy || !importUrl.trim()}
            onClick={() => void runAction(t('Import from URL'), (bridge) => bridge.importUrl(importUrl.trim()))}
            className="flex h-row-sm shrink-0 items-center gap-1.5 rounded-control bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-50"
          >
            {t('Import from URL')}
          </button>
        </div>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void runAction(t('Export'), (bridge) => bridge.export())}
          className="flex h-row-sm items-center gap-1.5 rounded-control bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-50"
        >
          {t('Export')}
        </button>
      </div>

      {message && (
        <p className="truncate border-b border-border-main px-4 py-1.5 text-xs text-text-secondary" title={message}>
          {message}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <LoamVideoPanel
          onStatusChange={setStatus}
          onBridgeReady={(bridge) => {
            bridgeRef.current = bridge;
          }}
        />
      </div>
    </div>
  );
}

function summarize(result: unknown): string {
  if (result === undefined) return 'ok';
  if (result === null) return 'ok (null)';
  if (typeof result === 'string') return result.length > 120 ? result.slice(0, 120) + '…' : result;
  try {
    const text = JSON.stringify(result);
    if (text === undefined) return String(result);
    return text.length > 120 ? text.slice(0, 120) + '…' : text;
  } catch {
    return String(result);
  }
}
