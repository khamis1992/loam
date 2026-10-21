'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiBase, getApiHeaders } from '@/services/rpc';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

interface TranscriptionResult {
  segments?: Array<{ start: number; end: number; text: string }>;
  text?: string;
  error?: string;
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

export interface VoiceTranscribe {
  state: VoiceState;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Records microphone audio with MediaRecorder and posts the bytes to the
 * server proxy POST /api/voice/transcribe (which forwards to the local STT
 * server). Returns the transcript text, or null.
 */
export function useVoiceTranscribe(onTranscript: (text: string) => void): VoiceTranscribe {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    };
  }, []);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setState('transcribing');
    try {
      const bytes = await blob.arrayBuffer();
      const res = await fetch(`${getApiBase()}/api/voice/transcribe`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const data = (await res.json().catch(() => ({}))) as TranscriptionResult;
      if (!res.ok) throw new Error(data.error || `transcribe ${res.status}`);
      const text = (data.text ?? (data.segments ?? []).map((s) => s.text.trim()).filter(Boolean).join(' ')).trim();
      if (text) onTranscript(text);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setState('idle');
    }
  }, [onTranscript]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        cleanup();
        if (mountedRef.current) void transcribe(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
      setState('recording');
    } catch (e) {
      cleanup();
      setState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [state, cleanup, transcribe]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') recorder.stop();
  }, []);

  return { state, error, start, stop };
}
