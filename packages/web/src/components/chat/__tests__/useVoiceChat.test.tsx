import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { createRef } from 'react';

// The Composer reads connectors/skills from the backend on mount; keep it quiet.
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
  getSessionToken: async () => '',
  handleAuthFailure: () => {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Composer, type ComposerHandle } from '../Composer';
import { VoiceChatControls } from '../VoiceChatControls';
import { useVoiceChat, type VoiceChat } from '@/hooks/useVoiceChat';

/* ---------------- fakes for the Web Speech APIs jsdom lacks ---------------- */

interface EmittedResult { isFinal: boolean; transcript: string }

class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  static last: FakeRecognition | null = null;
  constructor() { FakeRecognition.last = this; }
  start() { this.startCount += 1; }
  stop() { this.stopCount += 1; this.onend?.(); }
  emit(results: EmittedResult[], resultIndex = 0): void {
    this.onresult?.({
      resultIndex,
      results: results.map((r) => ({ isFinal: r.isFinal, length: 1, 0: { transcript: r.transcript } })),
    });
  }
}

class FakeUtterance {
  text: string;
  lang = '';
  voice: { name?: string } | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(text: string) { this.text = text; }
}

interface SpokenEntry { text: string; lang: string; voiceName: string | null }

function installRecognition(): void {
  const w = window as unknown as Record<string, unknown>;
  delete w.SpeechRecognition;
  w.webkitSpeechRecognition = FakeRecognition;
  FakeRecognition.last = null;
}

function installSynthesis() {
  const spoken: SpokenEntry[] = [];
  const controls = { autoFinish: true };
  let current: FakeUtterance | null = null;
  const cancel = vi.fn(() => {
    const u = current;
    current = null;
    u?.onend?.();
  });
  const speak = vi.fn((u: FakeUtterance) => {
    current = u;
    spoken.push({ text: u.text, lang: u.lang, voiceName: u.voice?.name ?? null });
    if (controls.autoFinish) { current = null; u.onend?.(); }
  });
  const synth = {
    speaking: false,
    getVoices: () => [
      { name: 'Microsoft Hamed - Arabic', lang: 'ar-SA' },
      { name: 'English Voice', lang: 'en-US' },
    ],
    speak,
    cancel,
  };
  const w = window as unknown as Record<string, unknown>;
  w.speechSynthesis = synth;
  w.SpeechSynthesisUtterance = FakeUtterance;
  return { spoken, cancel, controls };
}

function removeSpeechGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
  delete w.speechSynthesis;
  delete w.SpeechSynthesisUtterance;
}

const flush = () => act(async () => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
});

/* ------------------------- the harness component ------------------------- */

let currentVoice: VoiceChat | null = null;

function Harness(props: { onFinalTranscript?: (text: string) => void }) {
  const voice = useVoiceChat({ onFinalTranscript: props.onFinalTranscript });
  currentVoice = voice;
  return <VoiceChatControls voice={voice} />;
}

/* ------------------------------- the tests ------------------------------- */

describe('useVoiceChat + VoiceChatControls (W5 task-chat voice)', () => {
  afterEach(() => {
    cleanup();
    removeSpeechGlobals();
    window.localStorage.clear();
    currentVoice = null;
  });

  it('renders the mic and speaker controls with the off defaults', () => {
    installRecognition();
    installSynthesis();
    render(<Harness />);
    const mic = screen.getByTestId('voice-mic');
    expect(mic.getAttribute('aria-label')).toBe('Talk');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    const speaker = screen.getByTestId('voice-autospeak');
    expect(speaker.getAttribute('aria-label')).toBe('Auto-speak replies');
    expect(speaker.getAttribute('aria-pressed')).toBe('false');
  });

  it('starts ar-SA continuous recognition, shows interim text, and delivers the final transcript', async () => {
    const onFinal = vi.fn();
    installRecognition();
    installSynthesis();
    render(<Harness onFinalTranscript={onFinal} />);
    fireEvent.click(screen.getByTestId('voice-mic'));
    const rec = FakeRecognition.last!;
    expect(rec.lang).toBe('ar-SA');
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.startCount).toBe(1);
    expect(screen.getByTestId('voice-mic').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      rec.emit([{ isFinal: false, transcript: 'مرح' }]);
    });
    expect(screen.getByTestId('voice-interim').textContent).toBe('مرح');

    await act(async () => {
      rec.emit([{ isFinal: false, transcript: 'مرح' }, { isFinal: true, transcript: '  مرحبا بالعالم  ' }]);
    });
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('مرحبا بالعالم');
    expect(screen.queryByTestId('voice-interim')).toBeNull();
  });

  it('keeps the recognizer alive across engine sessions until toggled off', async () => {
    installRecognition();
    installSynthesis();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('voice-mic'));
    const rec = FakeRecognition.last!;
    await act(async () => { rec.onend?.(); });
    expect(rec.startCount).toBe(2);
    fireEvent.click(screen.getByTestId('voice-mic'));
    expect(rec.stopCount).toBe(1);
    expect(screen.getByTestId('voice-mic').getAttribute('aria-pressed')).toBe('false');
    await act(async () => { rec.onend?.(); });
    expect(rec.startCount).toBe(2);
  });

  it('holds the trailing fragment and speaks sentences only as they complete', async () => {
    installRecognition();
    const { spoken } = installSynthesis();
    render(<Harness />);
    // A finished sentence with nothing after it yet: held back (no boundary).
    await act(async () => { currentVoice!.feedReply('الجملة الأولى.', false); });
    await flush();
    expect(spoken.map((s) => s.text)).toEqual([]);
    // The next delta brings the whitespace after the period: sentence one speaks.
    await act(async () => { currentVoice!.feedReply('الجملة الأولى. والجملة الثانية', false); });
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(['الجملة الأولى.']);
    // Still no boundary for the second sentence; the final flush completes it.
    await act(async () => { currentVoice!.feedReply('الجملة الأولى. والجملة الثانية', true); });
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(['الجملة الأولى.', 'والجملة الثانية']);
  });

  it('prefers an Arabic voice for synthesis', async () => {
    installRecognition();
    const { spoken } = installSynthesis();
    render(<Harness />);
    await act(async () => { currentVoice!.feedReply('جملة كاملة.', true); });
    await flush();
    expect(spoken.length).toBe(1);
    expect(spoken[0].voiceName).toBe('Microsoft Hamed - Arabic');
    expect(spoken[0].lang).toBe('ar-SA');
  });

  it('persists the auto-speak flag and restores it on the next mount', () => {
    installRecognition();
    installSynthesis();
    const first = render(<Harness />);
    fireEvent.click(screen.getByTestId('voice-autospeak'));
    expect(window.localStorage.getItem('loam.voice.autoSpeak')).toBe('1');
    expect(screen.getByTestId('voice-autospeak').getAttribute('aria-pressed')).toBe('true');
    first.unmount();

    installRecognition();
    installSynthesis();
    render(<Harness />);
    expect(screen.getByTestId('voice-autospeak').getAttribute('aria-pressed')).toBe('true');
  });

  it('turning auto-speak off stops playback immediately', async () => {
    installRecognition();
    const { spoken, cancel, controls } = installSynthesis();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('voice-autospeak'));
    controls.autoFinish = false;
    await act(async () => { currentVoice!.feedReply('جملة أولى. جملة ثانية.', true); });
    await flush();
    expect(spoken.length).toBe(1);
    expect(screen.getByTestId('voice-speaking')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-autospeak'));
    expect(cancel).toHaveBeenCalled();
    await flush();
    expect(spoken.length).toBe(1);
    expect(screen.queryByTestId('voice-speaking')).toBeNull();
    expect(window.localStorage.getItem('loam.voice.autoSpeak')).toBe('0');
  });

  it('user speech barges in: playback stops and the queued remainder is dropped', async () => {
    installRecognition();
    const { spoken, cancel, controls } = installSynthesis();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('voice-autospeak'));
    fireEvent.click(screen.getByTestId('voice-mic'));
    controls.autoFinish = false;
    await act(async () => { currentVoice!.feedReply('جملة أولى. جملة ثانية. جملة ثالثة.', true); });
    await flush();
    expect(spoken.length).toBe(1);
    expect(screen.getByTestId('voice-speaking')).toBeTruthy();
    // The user starts talking over the reply.
    await act(async () => {
      FakeRecognition.last!.emit([{ isFinal: false, transcript: 'مقاطعة' }]);
    });
    expect(cancel).toHaveBeenCalled();
    await flush();
    expect(spoken.length).toBe(1);
    expect(screen.queryByTestId('voice-speaking')).toBeNull();
  });

  it('starting the mic while speaking stops the synthesis', async () => {
    installRecognition();
    const { cancel, controls } = installSynthesis();
    render(<Harness />);
    controls.autoFinish = false;
    await act(async () => { currentVoice!.feedReply('جملة طويلة تُنطق الآن.', true); });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-mic'));
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('unmount stops both the recognizer and the synthesis', async () => {
    installRecognition();
    const { cancel } = installSynthesis();
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByTestId('voice-mic'));
    const rec = FakeRecognition.last!;
    await act(async () => { currentVoice!.feedReply('جملة للنطق.', true); });
    unmount();
    expect(rec.stopCount).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalled();
  });

  it('no-ops gracefully where the browser lacks the speech APIs', async () => {
    removeSpeechGlobals();
    const onFinal = vi.fn();
    render(<Harness onFinalTranscript={onFinal} />);
    expect(screen.queryByTestId('voice-chat-controls')).toBeNull();
    await act(async () => { currentVoice!.toggleMic(); });
    await act(async () => {
      currentVoice!.feedReply('نص للنطق.', true);
      currentVoice!.resetReply();
      currentVoice!.stopSpeaking();
      currentVoice!.toggleAutoSpeak();
    });
    expect(onFinal).not.toHaveBeenCalled();
    expect(currentVoice!.supported).toEqual({ recognition: false, synthesis: false });
  });
});

/* ----------------- the minimal composer submit-path change ----------------- */

describe('ComposerHandle.submit (W5 voice routing)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('routes a finalized transcript through the composer send path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json({})));
    const onSend = vi.fn();
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} onSend={onSend} />);
    await act(async () => { ref.current!.submit('مرحبا، كيف أساعدك؟'); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('مرحبا، كيف أساعدك؟', 'standard', [], undefined);
  });
});
