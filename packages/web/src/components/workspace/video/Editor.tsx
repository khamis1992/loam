'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/i18n/t';
import type { WorkspaceEditorProps } from '../types';

type Clip = { id: string; in: number; out: number };
type Overlay = { id: string; text: string; start: number; end: number; x: number; y: number };
type Edl = { version: 1; sourceDuration?: number; clips: Clip[]; overlays: Overlay[] };

type HydrateResponse = {
  edl: Edl;
  persisted: boolean;
  bytes: number;
  mtime: string;
  duration?: number;
  hasAudio?: boolean;
};

type JobResponse = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  progress: number;
  output?: string;
  error?: string;
};

const fmt2 = (n: number): string => n.toFixed(2);
const newId = (): string =>
  (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `clip-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

export function Editor({ file, live, onChatEdit }: WorkspaceEditorProps) {
  const [edl, setEdl] = useState<Edl | undefined>();
  const [duration, setDuration] = useState<number>(0);
  const [hasAudio, setHasAudio] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [previewPath, setPreviewPath] = useState<string>(file.path);
  const [previewNonce, setPreviewNonce] = useState<number>(0);
  const [dirty, setDirty] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [chatDraft, setChatDraft] = useState<string>('');
  const [overlayDraft, setOverlayDraft] = useState<string>('');
  const [job, setJob] = useState<JobResponse | undefined>();
  const [lastOutput, setLastOutput] = useState<string | undefined>();
  const [hydrated, setHydrated] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastMtimeRef = useRef<string | undefined>(undefined);

  const sourceUrl = useMemo(
    () => `/api/workspace/video/file?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(previewPath)}&v=${previewNonce}`,
    [file.taskId, previewPath, previewNonce],
  );

  // hydrate once
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/workspace/video/hydrate?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`,
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as HydrateResponse;
        if (gone) return;
        lastMtimeRef.current = data.mtime;
        setDuration(data.edl.sourceDuration ?? data.duration ?? 0);
        setHasAudio(data.hasAudio ?? false);
        const clips = data.edl.clips.length ? data.edl.clips : [{ id: 'clip-1', in: 0, out: data.duration ?? data.edl.sourceDuration ?? 0 }];
        const valid = clips.filter((c) => c.out > c.in);
        setEdl({ ...data.edl, clips: valid });
        setSelectedId(valid[0]?.id);
      } catch (err) {
        if (!gone) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!gone) setHydrated(true);
      }
    })();
    return () => { gone = true; };
  }, [file.taskId, file.path]);

  // live: while the task runs, refresh the preview when the file changes
  useEffect(() => {
    if (!live || !hydrated) return;
    const poll = () => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/workspace/video/meta?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`,
          );
          if (!res.ok) return;
          const data = (await res.json()) as { mtime: string; duration?: number };
          if (lastMtimeRef.current && data.mtime !== lastMtimeRef.current) {
            lastMtimeRef.current = data.mtime;
            setPreviewNonce((n) => n + 1);
            if (data.duration) setDuration(data.duration);
          } else if (!lastMtimeRef.current) lastMtimeRef.current = data.mtime;
        } catch { /* task is still writing: retry next tick */ }
      })();
    };
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [live, hydrated, file.taskId, file.path]);

  const total = useMemo(() => (edl ? edl.clips.reduce((s, c) => s + (c.out - c.in), 0) : 0), [edl]);

  const activeIndex = useMemo(
    () => (edl && selectedId ? edl.clips.findIndex((c) => c.id === selectedId) : 0),
    [edl, selectedId],
  );
  const active = edl ? edl.clips[activeIndex] : undefined;

  const mutate = useCallback((fn: (draft: Edl) => void) => {
    setEdl((prev) => {
      if (!prev) return prev;
      const draft: Edl = { ...prev, clips: prev.clips.map((c) => ({ ...c })), overlays: prev.overlays.map((o) => ({ ...o })) };
      fn(draft);
      return draft;
    });
    setDirty(true);
    setJob(undefined);
  }, []);

  const playheadSourceTime = useCallback((): number | undefined => {
    const el = videoRef.current;
    if (!el) return undefined;
    return Number.isFinite(el.currentTime) ? el.currentTime : undefined;
  }, []);

  const seekTo = useCallback((sourceTime: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = sourceTime;
  }, []);

  const splitAtPlayhead = useCallback(() => {
    const t = playheadSourceTime();
    if (!active || t == null || t <= active.in + 0.05 || t >= active.out - 0.05) return;
    const before: Clip = { id: newId(), in: active.in, out: t };
    const after: Clip = { id: newId(), in: t, out: active.out };
    mutate((draft) => { draft.clips.splice(activeIndex, 1, before, after); });
    setSelectedId(before.id);
  }, [active, activeIndex, mutate, playheadSourceTime]);

  const moveSelected = useCallback((dir: -1 | 1) => {
    if (!edl || activeIndex < 0) return;
    const target = activeIndex + dir;
    if (target < 0 || target >= edl.clips.length) return;
    mutate((draft) => {
      const [seg] = draft.clips.splice(activeIndex, 1);
      draft.clips.splice(target, 0, seg);
    });
  }, [activeIndex, edl, mutate]);

  const deleteSelected = useCallback(() => {
    if (!edl || edl.clips.length <= 1) return;
    const remaining = edl.clips[activeIndex + 1] ?? edl.clips[activeIndex - 1];
    mutate((draft) => { draft.clips.splice(activeIndex, 1); });
    setSelectedId(remaining?.id);
  }, [activeIndex, edl, mutate]);

  const trimInToPlayhead = useCallback(() => {
    const pv = playheadSourceTime();
    if (!active || pv == null) return;
    const nextIn = Math.max(0, Math.min(pv, active.out - 0.05));
    mutate((draft) => {
      const seg = draft.clips[activeIndex];
      if (seg) draft.clips[activeIndex] = { ...seg, in: nextIn };
    });
  }, [active, activeIndex, mutate, playheadSourceTime]);

  const trimOutToPlayhead = useCallback(() => {
    const pv = playheadSourceTime();
    if (!active || pv == null || pv - active.in < 0.05) return;
    const nextOut = Math.max(active.in + 0.05, Math.min(pv, duration || pv));
    mutate((draft) => {
      const seg = draft.clips[activeIndex];
      if (seg) draft.clips[activeIndex] = { ...seg, out: nextOut };
    });
  }, [active, activeIndex, duration, mutate, playheadSourceTime]);

  // Overlay times live on the rendered (concatenated) timeline, not source time.
  const addOverlay = useCallback(() => {
    const text = overlayDraft.trim();
    if (!text || !active || !edl) return;
    const offset = edl.clips.slice(0, Math.max(0, activeIndex)).reduce((s, c) => s + (c.out - c.in), 0);
    const durationSec = active.out - active.in;
    const start = offset;
    const end = offset + durationSec;
    const startClamped = Math.max(0, Math.min(start, end - 0.05));
    const overlay: Overlay = { id: newId(), text, start: startClamped, end: Math.max(startClamped + 0.05, end), x: 10, y: 10 };
    mutate((draft) => { draft.overlays.push(overlay); });
    setOverlayDraft('');
  }, [active, activeIndex, edl, mutate, overlayDraft]);

  const saveEdl = useCallback(async () => {
    if (!edl) return;
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetch(
        `/api/workspace/video/file?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path + '.edl.json')}`,
        { method: 'PUT', body: JSON.stringify({ ...edl, sourceDuration: duration }) },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setSavedAt(new Date().toLocaleTimeString());
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [duration, edl, file.path, file.taskId]);

  const render = useCallback(() => {
    if (!edl) return;
    setError(undefined);
    setJob({ id: '', status: 'queued', progress: 0 });
    void (async () => {
      try {
        const res = await fetch('/api/workspace/video/render', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: file.taskId, path: file.path, edl: { ...edl, sourceDuration: duration } }),
        });
        if (!res.status || res.status < 200 || res.status >= 300) {
          throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { jobId: string };
        pollJob(data.jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setJob(undefined);
      }
    })();
  }, [duration, edl, file.path, file.taskId]);

  const pollJob = useCallback((jobId: string) => {
    void (async () => {
      try {
        const res = await fetch(`/api/workspace/video/render/${encodeURIComponent(jobId)}`);
        if (!res.ok) throw new Error('render job lost');
        const data = (await res.json()) as JobResponse;
        setJob(data);
        if (data.status === 'queued' || data.status === 'running') {
          window.setTimeout(() => pollJob(jobId), 800);
        } else if (data.status === 'done') {
          setLastOutput(data.output);
          setPreviewPath(data.output ?? file.path);
          setPreviewNonce((n) => n + 1);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setJob(undefined);
      }
    })();
  }, [file.path]);

  const cancelJob = useCallback(() => {
    if (!job?.id) return;
    void (async () => {
      try {
        const res = await fetch(`/api/workspace/video/render/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as { status?: JobResponse['status'] };
        setJob((prev) => (prev ? { ...prev, status: data.status ?? 'canceled' } : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [job?.id]);

  if (!edl) {
    return (
      <div className="p-6 text-text-secondary">{error ? `${t('Video editor error')}: ${error}` : t('Loading video editor')}</div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto rounded-card bg-bg-menu p-3 text-text-primary">
      {error && <div className="rounded-control bg-func-error/10 p-2 text-func-error">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text-primary">{file.name}</span>
        {live && <span className="rounded-control bg-fill-tsp px-2 text-text-secondary">{t('Task running')}</span>}
        {dirty && <span className="text-text-tertiary">{t('Unsaved EDL')}</span>}
        {savedAt && !dirty && <span className="text-text-tertiary">{t('Saved at')} {savedAt}</span>}
        <span className="grow" />
        <button onClick={saveEdl} disabled={saving} className="rounded-control border border-border-main px-3 py-1 text-text-primary hover:bg-fill-hover disabled:opacity-50">
          {t('Save EDL')}
        </button>
        <button onClick={render} disabled={!!job && (job.status === 'queued' || job.status === 'running')} className="rounded-control bg-text-primary px-3 py-1 text-text-onblack hover:opacity-80 disabled:opacity-50">
          {t('Apply')}
        </button>
      </div>

      {job && (job.status === 'queued' || job.status === 'running') && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          {t('Rendering')} {Math.round(job.progress)}%
          {job.id && (
            <button onClick={cancelJob} className="rounded-control border border-border-main px-2 py-0.5 text-func-error hover:bg-fill-hover">
              {t('Cancel render')}
            </button>
          )}
        </div>
      )}
      {job?.status === 'done' && <div className="text-xs text-func-success">{t('Render complete')}</div>}
      {job?.status === 'error' && <div className="text-xs text-func-error">{job.error ?? t('Render failed')}</div>}

      <div className="grow rounded-row border border-border-light bg-black p-2">
        <video src={sourceUrl} controls className="mx-auto h-full max-h-80 w-full object-contain" />
        {lastOutput && previewPath !== lastOutput && (
          <button onClick={() => { setPreviewPath(lastOutput); setPreviewNonce((n) => n + 1); }} className="mt-2 rounded-control border border-border-main px-2 py-0.5 text-text-tertiary hover:bg-fill-hover">
            {t('Preview rendered output')}
          </button>
        )}
        {previewPath === lastOutput && previewPath !== file.path && (
          <button onClick={() => { setPreviewPath(file.path); setPreviewNonce((n) => n + 1); }} className="mt-2 rounded-control border border-border-main px-2 py-0.5 text-text-tertiary hover:bg-fill-hover">
            {t('Back to source')}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="h-8 overflow-hidden rounded-control border border-border-light bg-fill-tsp">
          <div className="flex h-full items-stretch">
            {edl.clips.map((clip) => {
              const green = (clip.out - clip.in) / (total || 1);
              const isActive = clip.id === selectedId;
              return (
                <div
                  key={clip.id}
                  role="button"
                  aria-label={`${t('Segment')} ${fmt2(clip.in)}-${fmt2(clip.out)}`}
                  tabIndex={0}
                  onClick={() => { setSelectedId(clip.id); seekTo(clip.in); }}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedId(clip.id)}
                  style={{ width: `${green * 100}%` }}
                  className={`flex min-w-2 items-center justify-center overflow-hidden border-r border-bg-main px-1 text-[10px] ${isActive ? 'bg-text-primary text-text-onblack' : 'bg-fill-hover text-text-secondary'} hover:opacity-80`}
                >
                  {fmt2(clip.in)}-{fmt2(clip.out)}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button onClick={() => { if (active) seekTo(active.in); }} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover">{t('Go to segment')}</button>
          <button onClick={splitAtPlayhead} disabled={!active} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-50">{t('Split at playhead')}</button>
          <button onClick={trimInToPlayhead} disabled={!active} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-50">{t('Trim in')}</button>
          <button onClick={trimOutToPlayhead} disabled={!active} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-50">{t('Trim out')}</button>
          <button onClick={deleteSelected} disabled={!edl || edl.clips.length <= 1} className="rounded-control border border-border-main px-2 py-0.5 text-func-error hover:bg-fill-hover disabled:opacity-40">{t('Delete segment')}</button>
          <button onClick={() => moveSelected(-1)} disabled={activeIndex <= 0} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-40">{t('Move earlier')}</button>
          <button onClick={() => moveSelected(1)} disabled={!edl || activeIndex >= edl.clips.length - 1} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-40">{t('Move later')}</button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <input
            aria-label={t('New text overlay')}
            value={overlayDraft}
            onChange={(e) => setOverlayDraft(e.target.value)}
            placeholder={t('Add text overlay')}
            className="w-56 rounded-control border border-border-main bg-bg-nav px-2 py-0.5 text-text-primary outline-none"
          />
          <button onClick={addOverlay} disabled={!active} className="rounded-control border border-border-main px-2 py-0.5 text-text-primary hover:bg-fill-hover disabled:opacity-40">{t('Add overlay')}</button>
        </div>
      </div>

      {edl.overlays.length > 0 && (
        <div className="flex flex-col gap-1">
          {edl.overlays.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-1 rounded-control border border-border-light p-1 text-text-secondary">
              <input
                aria-label={t('Overlay text')}
                value={o.text}
                onChange={(e) => mutate((draft) => { draft.overlays = draft.overlays.map((x) => x.id === o.id ? { ...x, text: e.target.value } : x); })}
                className="w-40 rounded-control border border-border-main bg-bg-nav px-1 text-text-primary outline-none"
              />
              <label className="text-[10px]">{t('Start')}<input type="number" step="0.1" aria-label={t('Overlay start')} value={o.start} onChange={(e) => mutate((draft) => { draft.overlays = draft.overlays.map((x) => x.id === o.id ? { ...x, start: Math.max(0, Number(e.target.value) || 0) } : x); })} className="w-16 rounded-control border border-border-main bg-bg-nav px-1 text-text-primary outline-none" /></label>
              <label className="text-[10px]">{t('End')}<input type="number" step="0.1" aria-label={t('Overlay end')} value={o.end} onChange={(e) => mutate((draft) => { draft.overlays = draft.overlays.map((x) => x.id === o.id ? { ...x, end: Math.max(0, Number(e.target.value) || 0) } : x); })} className="w-16 rounded-control border border-border-main bg-bg-nav px-1 text-text-primary outline-none" /></label>
              <label className="text-[10px]">{t('X')}<input type="number" step="1" aria-label={t('Overlay x')} value={o.x} onChange={(e) => mutate((draft) => { draft.overlays = draft.overlays.map((x) => x.id === o.id ? { ...x, x: Math.max(0, Math.min(99, Number(e.target.value) || 0)) } : x); })} className="w-12 rounded-control border border-border-main bg-bg-nav px-1 text-text-primary outline-none" /></label>
              <label className="text-[10px]">{t('Y')}<input type="number" step="1" aria-label={t('Overlay y')} value={o.y} onChange={(e) => mutate((draft) => { draft.overlays = draft.overlays.map((x) => x.id === o.id ? { ...x, y: Math.max(0, Math.min(99, Number(e.target.value) || 0)) } : x); })} className="w-12 rounded-control border border-border-main bg-bg-nav px-1 text-text-primary outline-none" /></label>
              <button onClick={() => mutate((draft) => { draft.overlays = draft.overlays.filter((x) => x.id !== o.id); })} className="rounded-control border border-border-main px-2 py-0.5 text-func-error hover:bg-fill-hover">{t('Remove overlay')}</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <input
          aria-label={t('Chat edit instruction')}
          value={chatDraft}
          onChange={(e) => setChatDraft(e.target.value)}
          placeholder={t('Edit via chat')}
          className="grow rounded-control border border-border-main bg-bg-nav px-2 py-0.5 text-text-primary outline-none"
        />
        <button
          onClick={() => {
            const instruction = chatDraft.trim();
            if (!instruction) return;
            onChatEdit(`Edit ${file.path}: ${instruction}`);
            setChatDraft('');
          }}
          className="rounded-control border border-border-main px-3 py-0.5 text-text-primary hover:bg-fill-hover"
        >
          {t('Send')}
        </button>
      </div>
    </div>
  );
}

function draftRemember(edl: Edl, index: number): Clip | undefined { return edl.clips[index + 1] ?? edl.clips[index - 1]; }

export default Editor;
