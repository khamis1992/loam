'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, XCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { t, PRODUCT } from '@/i18n/t';
import { EventList } from '@/components/chat/EventList';
import { getApiBase, getLoamBase } from '@/services/rpc';
import type { ChatEvent, ChatMessageEvent } from '@shared/socket';

interface SharedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
}

interface SharedTranscript {
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: SharedMessage[];
  artifacts: string[];
}

/**
 * Public read-only share replay (option #11): /share?t=<token> renders the
 * shared transcript with the same chat components as the live task view —
 * no composer, no actions, nothing else. Data comes from GET /api/share/:token.
 */
function ShareReplay() {
  const searchParams = useSearchParams();
  const token = searchParams.get('t') ?? '';
  const [state, setState] = useState<'loading' | 'ready' | 'not-found' | 'invalid'>('loading');
  const [transcript, setTranscript] = useState<SharedTranscript | null>(null);

  useEffect(() => {
    if (!token.trim()) { setState('invalid'); return; }
    let cancelled = false;
    (async () => {
      // Desktop renders behind the protocol adapter; a hosted web deployment
      // uses the same-origin /api; a direct Loam server is the last resort.
      const bases = [...new Set([getApiBase(), getLoamBase()])];
      for (const base of bases) {
        try {
          const res = await fetch(`${base}/api/share/${encodeURIComponent(token)}`);
          if (res.status === 404) { if (!cancelled) setState('not-found'); continue; }
          if (!res.ok) continue;
          const data = (await res.json()) as { transcript?: SharedTranscript };
          if (!data.transcript) continue;
          if (!cancelled) { setTranscript(data.transcript); setState('ready'); }
          return;
        } catch {
          // try the next base
        }
      }
      if (!cancelled) setState('not-found');
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const events: ChatEvent[] = useMemo(() => (transcript?.messages ?? [])
    .filter((m) => m.role !== 'system')
    .map((m, i): ChatMessageEvent => ({
      id: `share-${i}`,
      type: 'chat',
      timestamp: Date.parse(m.at) || 0,
      sender: m.role === 'user' ? 'user' : 'assistant',
      messageType: 'text',
      content: m.content,
      attachments: [],
      deliveryKind: 'result',
    })), [transcript]);

  return (
    <main className="mx-auto w-full max-w-[768px] px-6 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="text-lg">◉</span>
        <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
        <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-fill-tsp px-2.5 py-1 text-xs text-text-secondary">
          <Link2 className="size-3" aria-hidden /> {t('Read-only shared task')}
        </span>
      </div>
      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary">
          <Loader2 className="size-5 animate-spin" /> {t('Loading')}
        </div>
      )}
      {(state === 'not-found' || state === 'invalid') && (
        <div className="flex flex-col items-center gap-2 py-16 text-sm text-text-secondary">
          <XCircle className="size-6 text-function-error" aria-hidden />
          {t('This share link is invalid or has been revoked.')}
        </div>
      )}
      {state === 'ready' && transcript && (
        <>
          <h1 className="mb-2 text-xl font-semibold text-text-primary">{transcript.title}</h1>
          {transcript.artifacts.length > 0 && (
            <p className="mb-4 text-sm text-text-tertiary">
              {t('Files produced: {names}', { names: transcript.artifacts.join(', ') })}
            </p>
          )}
          <EventList events={events} sessionId="share" />
        </>
      )}
    </main>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-text-secondary">{t('Loading')}</div>}>
      <ShareReplay />
    </Suspense>
  );
}
