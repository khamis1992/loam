'use client';

import { useEffect, useState } from 'react';
import { getLocale, t } from '@/i18n/t';
import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';
import { answerNativeBridge } from './nativeBridge';
import type { WorkspaceEditorProps } from '../types';

function recorderFrame(): string {
  return `loamrecorder://app/index.html?loam=1&windowType=editor&lang=${getLocale()}`;
}

interface RecorderStatus {
  installed: boolean;
  rev: string | null;
  helper: 'ok' | 'missing';
  compositor: 'ok' | 'missing';
  capture?: 'helper' | 'ffmpeg' | 'missing';
  state?: string;
  recording?: boolean;
  project?: string;
}

async function recorderFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getLoamBase()}${path}`, {
    ...init,
    headers: { ...getLoamAuthHeaders(), ...(init?.headers ?? {}) },
  });
}

/** Workspace page for Loam Recorder. Capture starts only after this button, which is the consent. */
export default function RecorderPanel(_props: WorkspaceEditorProps) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [note, setNote] = useState('');
  const [includeAudio, setIncludeAudio] = useState(true);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = document.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; id?: string; channel?: string; method?: string; args?: unknown[]; params?: Record<string, unknown> } | null;
      if (!data || (data.type !== 'recorder:ipc' && data.type !== 'recorder:call' && data.type !== 'recorder:ready')) return;
      if (data.type === 'recorder:ready') return;
      if (data.type === 'recorder:ipc' && data.channel === 'native-bridge:invoke') {
        frame.contentWindow?.postMessage({
          type: 'recorder:ipc-result',
          id: data.id,
          ok: true,
          result: answerNativeBridge(data.args?.[0]),
        }, '*');
        return;
      }
      const method = data.type === 'recorder:ipc' ? data.channel : data.method;
      if (!method) return;
      const params = data.type === 'recorder:ipc'
        ? (data.args && typeof data.args[0] === 'object' && data.args[0] ? data.args[0] as Record<string, unknown> : {})
        : (data.params ?? {});
      void call(method, params).then((result) => {
        const failed = result.ok === false || Boolean(result.error);
        frame.contentWindow?.postMessage({
          type: data.type === 'recorder:ipc' ? 'recorder:ipc-result' : 'recorder:result',
          id: data.id,
          ok: !failed,
          result: result.result,
          error: result.error,
        }, '*');
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void recorderFetch('/api/recorder/status')
        .then((res) => res.json() as Promise<RecorderStatus>)
        .then((body) => {
          if (!cancelled) setStatus(body);
        })
        .catch(() => {
          if (!cancelled) setStatus({ installed: false, rev: null, helper: 'missing', compositor: 'missing', capture: 'missing' });
        });
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!status?.installed || status.project) return;
    void recorderFetch('/api/recorder/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'project.open', params: { sample: true } }),
    }).catch(() => undefined);
  }, [status?.installed, status?.project]);

  async function call(method: string, params: Record<string, unknown>) {
    const res = await recorderFetch('/api/recorder/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    return res.json() as Promise<{ ok?: boolean; result?: { sessionId?: string }; error?: { message?: string } }>;
  }

  async function start() {
    setNote('');
    const consent = await recorderFetch('/api/recorder/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmed: true,
        sourceId: 'desktop',
        systemAudio: status?.capture === 'helper' && includeAudio,
        mic: false,
        webcam: false,
      }),
    });
    const grant = await consent.json() as { consentToken?: string };
    if (!grant.consentToken) {
      setNote(t('Loam Recorder could not ask for consent.'));
      return;
    }
    const started = await call('record.start', { sourceId: 'desktop', consentToken: grant.consentToken, countdownSec: 3 });
    if (started.result?.sessionId) setSessionId(started.result.sessionId);
    else setNote(started.error?.message || t('Loam Recorder could not start.'));
  }

  async function stop() {
    if (!sessionId) return;
    const stopped = await call('record.stop', { sessionId });
    if (stopped.ok) setSessionId('');
    else setNote(stopped.error?.message || t('Loam Recorder could not stop.'));
  }

  if (!status) return <p className="p-4 text-sm text-text-secondary">{t('Loading Loam Recorder…')}</p>;
  const canRecord = status.capture === 'ffmpeg' || status.capture === 'helper' || status.helper === 'ok';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-text-primary">{t('Loam Recorder')}</h2>
        {status.recording ? <span className="h-2.5 w-2.5 rounded-full bg-red-600" /> : null}
        {canRecord && !sessionId ? (
          <button type="button" className="rounded-md bg-text-primary px-3 py-1.5 text-sm text-white" onClick={() => void start()}>
            {t('Record screen')}
          </button>
        ) : null}
        {status.capture === 'helper' && !sessionId ? (
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={includeAudio} onChange={(event) => setIncludeAudio(event.target.checked)} />
            {t('Include system audio')}
          </label>
        ) : null}
        {sessionId ? (
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => void stop()}>
            {t('Stop recording')}
          </button>
        ) : null}
      </div>
      {note ? <p className="px-4 py-2 text-sm text-text-secondary">{note}</p> : null}
      {status.capture === 'helper' ? <p className="px-4 py-2 text-sm text-text-secondary">{t('This recording keeps the picture and system audio when that option stays on.')}</p> : null}
      {status.capture === 'ffmpeg' ? <p className="px-4 py-2 text-sm text-text-secondary">{t('This recording keeps the picture. System audio arrives with the Windows capture helper.')}</p> : null}
      {!canRecord && !status.installed ? (
        <div className="flex flex-col gap-2 p-6 text-sm text-text-secondary">
          <p>{t('Loam Recorder is not installed yet. The capture helper stays off until its package is present.')}</p>
        </div>
      ) : null}
      {status.installed ? <iframe title={t('Loam Recorder')} src={recorderFrame()} className="min-h-0 flex-1 border-0 bg-white" /> : null}
    </div>
  );
}
