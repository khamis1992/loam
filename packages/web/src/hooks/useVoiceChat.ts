'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Phase-2 W5: the Companions voice conversation pattern (ui/companions.js
 * "bidirectional voice conversation"), re-implemented as a React hook for the
 * main task chat:
 *
 * - Mic toggle: WebSpeech recognition (`SpeechRecognition`/`webkitSpeechRecognition`)
 *   locked to `ar-SA`, continuous with interim results; a finalized segment is
 *   delivered through `onFinalTranscript`. The recognizer restarts on its own
 *   `onend` while the user keeps the mic on (same loop as the Companions panel).
 * - Streaming TTS: `feedReply(text, finished)` accepts the growing assistant
 *   reply; completed sentences are spoken as they arrive (the trailing fragment
 *   is held back until sentence punctuation or the finished flag completes it),
 *   with an Arabic voice preferred and long unbroken runs chunked.
 * - Barge-in: starting the mic — or any speech the recognizer picks up — stops
 *   playback immediately and drops the queued remainder.
 *
 * Everything feature-detects and no-ops where the browser lacks the API, and
 * unmount stops both the recognizer and the synthesis.
 */

/** The slice of the (vendor-prefixed) recognition API this hook relies on. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string };
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function synthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.speechSynthesis.getVoices === 'function' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

/** Sentence boundary used by the Companions panel (Arabic + Latin stops). */
const SENTENCE_SPLIT = /(?<=[.!?؟…।])\s+/;
/** Hard cap per utterance; some engines truncate or refuse very long strings. */
const MAX_CHUNK = 200;

function chunkSentence(sentence: string): string[] {
  const piece = sentence.trim();
  if (piece.length <= MAX_CHUNK) return piece ? [piece] : [];
  const chunks: string[] = [];
  let rest = piece;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut <= 0) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks.filter(Boolean);
}

/** Prefer an ar-SA voice, then any Arabic voice, like the Companions picker. */
function pickArabicVoice(): SpeechSynthesisVoice | null {
  if (!synthesisSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang?.toLowerCase().startsWith('ar-sa')) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith('ar')) ??
    null
  );
}

export interface UseVoiceChatOptions {
  /** Called once per finalized mic segment (already trimmed). */
  onFinalTranscript?: (text: string) => void;
  /** localStorage flag for the auto-speak default; '1' means on. Default off. */
  storageKey?: string;
}

export interface VoiceChat {
  /** Feature detection results; unsupported controls are simply not offered. */
  supported: { recognition: boolean; synthesis: boolean };
  micOn: boolean;
  /** Live interim recognition hypothesis (shown near the composer). */
  interim: string;
  error: string | null;
  toggleMic: () => void;
  autoSpeak: boolean;
  toggleAutoSpeak: () => void;
  speaking: boolean;
  /** Feed the growing assistant reply; finished sentences speak while the rest streams. */
  feedReply: (text: string, finished: boolean) => void;
  /** Drop the current reply feed (a new assistant message started). */
  resetReply: () => void;
  /** Stop playback and drop every queued sentence (also the barge-in entry). */
  stopSpeaking: () => void;
}

export function useVoiceChat(options: UseVoiceChatOptions = {}): VoiceChat {
  const { onFinalTranscript, storageKey = 'loam.voice.autoSpeak' } = options;
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  const [supported] = useState(() => ({
    recognition: Boolean(getRecognitionCtor()),
    synthesis: synthesisSupported(),
  }));
  const [micOn, setMicOn] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);

  // --- recognition state ---
  const wantMicRef = useRef(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // --- synthesis state (the Companions queue/pump, in refs) ---
  const queueRef = useRef<string[]>([]);
  const pendingSentenceRef = useRef('');
  const pumpingRef = useRef(false);
  const disposedRef = useRef(false);
  /** How much of the current reply has already been handed to the queue. */
  const fedRef = useRef('');

  const autoSpeakRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    try {
      const stored = localStorage.getItem(storageKey) === '1';
      autoSpeakRef.current = stored;
      setAutoSpeak(stored);
    } catch {
      // Non-browser environment: keep the off default.
    }
    return () => {
      disposedRef.current = true;
      wantMicRef.current = false;
      try { recRef.current?.stop(); } catch { /* already stopped */ }
      recRef.current = null;
      queueRef.current = [];
      pendingSentenceRef.current = '';
      try { window.speechSynthesis?.cancel(); } catch { /* no synthesis */ }
    };
  }, [storageKey]);

  /** Speak one sentence, resolving when it ends or fails (Companions voicePump). */
  const speakOne = useCallback(async (sentence: string) => {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const utterance = new SpeechSynthesisUtterance(sentence);
        const voice = pickArabicVoice();
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || 'ar-SA';
        utterance.onend = finish;
        utterance.onerror = finish;
        window.speechSynthesis.speak(utterance);
      } catch {
        finish();
      }
    });
  }, []);

  const pump = useCallback(async () => {
    if (pumpingRef.current || queueRef.current.length === 0) return;
    if (!synthesisSupported()) { queueRef.current = []; return; }
    pumpingRef.current = true;
    setSpeaking(true);
    try {
      while (queueRef.current.length > 0 && !disposedRef.current) {
        const sentence = queueRef.current.shift();
        if (!sentence) continue;
        await speakOne(sentence);
      }
    } finally {
      pumpingRef.current = false;
      if (queueRef.current.length === 0) setSpeaking(false);
    }
  }, [speakOne]);

  /** Append raw reply text; only completed sentences enter the queue. */
  const enqueue = useCallback((text: string, flush: boolean) => {
    pendingSentenceRef.current += String(text ?? '');
    const parts = pendingSentenceRef.current.split(SENTENCE_SPLIT);
    // Hold the trailing fragment back until punctuation (or flush) completes it.
    pendingSentenceRef.current = flush ? '' : (parts.pop() ?? '');
    for (const part of parts) {
      for (const chunk of chunkSentence(part)) queueRef.current.push(chunk);
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    queueRef.current = [];
    pendingSentenceRef.current = '';
    try { window.speechSynthesis?.cancel(); } catch { /* no synthesis */ }
    if (!pumpingRef.current) setSpeaking(false);
  }, []);

  const feedReply = useCallback((text: string, finished: boolean) => {
    if (!synthesisSupported()) return;
    const value = String(text ?? '');
    // A rewritten/truncated reply restarts the feed from its beginning.
    if (!value.startsWith(fedRef.current)) fedRef.current = '';
    const suffix = value.slice(fedRef.current.length);
    fedRef.current = value;
    if (suffix) enqueue(suffix, false);
    if (finished) enqueue('', true);
    void pump();
  }, [enqueue, pump]);

  const resetReply = useCallback(() => {
    fedRef.current = '';
    queueRef.current = [];
    pendingSentenceRef.current = '';
    try { window.speechSynthesis?.cancel(); } catch { /* no synthesis */ }
  }, []);

  const startMic = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('speech-recognition-unavailable');
      return;
    }
    // Barge-in on mic start: talking over the reply kills playback right away.
    stopSpeaking();
    setError(null);
    setInterim('');
    const rec = new Ctor();
    rec.lang = 'ar-SA';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let interimText = '';
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i];
        const said = result?.[0]?.transcript ?? '';
        if (result.isFinal) finalText += said;
        else interimText += said;
      }
      // Any speech from the user interrupts the assistant mid-sentence.
      if (interimText.trim() || finalText.trim()) stopSpeaking();
      if (interimText.trim()) setInterim(interimText.trim());
      if (finalText.trim()) {
        setInterim('');
        onFinalRef.current?.(finalText.trim());
      }
    };
    rec.onerror = (ev) => {
      // Permission-style errors must not enter the restart loop below.
      const kind = ev?.error ?? 'microphone-error';
      if (kind === 'not-allowed' || kind === 'service-not-allowed') wantMicRef.current = false;
      setError(kind);
    };
    rec.onend = () => {
      // Keep the mic alive across the engine's short sessions while toggled on.
      if (wantMicRef.current && !disposedRef.current) {
        try { rec.start(); } catch { /* restarting too early */ }
      } else {
        setMicOn(false);
      }
    };
    recRef.current = rec;
    wantMicRef.current = true;
    try {
      rec.start();
      setMicOn(true);
    } catch {
      wantMicRef.current = false;
      recRef.current = null;
      setError('microphone-start-failed');
      setMicOn(false);
    }
  }, [stopSpeaking]);

  const stopMic = useCallback(() => {
    wantMicRef.current = false;
    setMicOn(false);
    setInterim('');
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    recRef.current = null;
  }, []);

  const toggleMic = useCallback(() => {
    if (wantMicRef.current) stopMic();
    else startMic();
  }, [startMic, stopMic]);

  const toggleAutoSpeak = useCallback(() => {
    const next = !autoSpeakRef.current;
    autoSpeakRef.current = next;
    setAutoSpeak(next);
    try {
      localStorage.setItem(storageKey, next ? '1' : '0');
    } catch {
      // Non-browser environment: skip persistence.
    }
    if (!next) stopSpeaking();
  }, [storageKey, stopSpeaking]);

  return {
    supported,
    micOn,
    interim,
    error,
    toggleMic,
    autoSpeak,
    toggleAutoSpeak,
    speaking,
    feedReply,
    resetReply,
    stopSpeaking,
  };
}
