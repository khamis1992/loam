'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2, Mic, Plus, ShieldCheck, Square, X } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { VoiceIcon } from '@/components/home/VoiceIcon';
import { useVoiceTranscribe } from '@/components/chat/useVoiceTranscribe';
import { speak, stopSpeaking } from '@/services/speech';
import type { TaskMode } from '@shared/socket';

export interface AgentThreadComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
}

export interface AgentThreadComposerProps {
  onSend: (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => void | Promise<void>;
  onStop?: () => void;
  running?: boolean;
  placeholder?: string;
  /** Latest assistant reply text; enables the voice-mode TTS toggle. */
  assistantReply?: string;
  approveForMe?: boolean;
  onToggleApproveForMe?: () => void;
}

/**
 * Compact Grok-style composer: one rounded bar with a "+" on the left and a
 * mic plus a black round send/voice button on the right.
 */
export function AgentThreadComposer({
  onSend,
  onStop,
  running,
  placeholder,
  assistantReply,
  approveForMe,
  onToggleApproveForMe,
}: AgentThreadComposerProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TaskMode>('standard');
  const [files, setFiles] = useState<File[]>([]);
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 || files.length > 0;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setVoiceModeOn(localStorage.getItem('agent-studio:voice-mode') === '1');
    }
  }, []);

  // Voice mode: speak each new assistant reply while enabled.
  const lastSpokenRef = useRef('');
  const reply = (assistantReply ?? '').trim();
  useEffect(() => {
    if (!voiceModeOn || !reply || reply === lastSpokenRef.current) return;
    lastSpokenRef.current = reply;
    speak(reply);
  }, [voiceModeOn, reply]);
  useEffect(() => () => stopSpeaking(), []);

  const onTranscript = (transcript: string) => {
    setText((prev) => (prev.trim() ? `${prev}\n${transcript}` : transcript));
    textareaRef.current?.focus();
  };
  const voice = useVoiceTranscribe(onTranscript);

  const toggleVoiceMode = () => {
    const next = !voiceModeOn;
    setVoiceModeOn(next);
    if (typeof window !== 'undefined') localStorage.setItem('agent-studio:voice-mode', next ? '1' : '0');
    lastSpokenRef.current = '';
    stopSpeaking();
  };

  const submit = async () => {
    if (!canSend) return;
    await onSend(text.trim(), mode, files);
    setText('');
    setFiles([]);
  };

  const onKey = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      await submit();
    }
  };

  const removeFile = (target: File) => setFiles((prev) => prev.filter((f) => f !== target));

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const incoming = e.dataTransfer.files;
        if (incoming) setFiles((prev) => [...prev, ...Array.from(incoming)]);
      }}
      className="rounded-composer border border-border-main bg-bg-menu p-2 shadow-card"
    >
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li
              key={`${f.name}-${f.lastModified}`}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-fill-tsp px-2 py-1 text-xs"
            >
              <span className="max-w-[140px] truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f)}
                aria-label={t('Remove file')}
                title={t('Remove file')}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label={t('Add files')}
          title={t('Add files')}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-fill-hover hover:text-text-primary"
        >
          <Plus className="size-5" />
        </button>

        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as TaskMode)}
          aria-label={t('Mode')}
          className="h-8 shrink-0 rounded-control bg-transparent px-1 text-xs text-text-secondary outline-none"
        >
          <option value="standard">{t('Standard')}</option>
          <option value="lite">{t('Lite')}</option>
          <option value="max">{t('Max')}</option>
        </select>

        {onToggleApproveForMe && (
          <button
            type="button"
            onClick={onToggleApproveForMe}
            aria-pressed={approveForMe === true}
            aria-label={t('Approve for me')}
            title={t('Approve for me')}
            className={clsx(
              'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
              approveForMe ? 'text-icon-blue hover:bg-fill-hover' : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary',
            )}
          >
            <ShieldCheck className="size-4" />
          </button>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder={placeholder ?? t('Message')}
          className="chat-input-editor max-h-40 min-w-0 flex-1 resize-none bg-transparent text-base leading-snug text-text-primary outline-none placeholder:text-text-disable"
        />

        <button
          type="button"
          aria-label={t(voice.state === 'recording' ? 'Stop recording' : 'Microphone')}
          title={t(voice.state === 'recording' ? 'Stop recording' : 'Microphone')}
          onClick={() => (voice.state === 'recording' ? voice.stop() : void voice.start())}
          className={clsx(
            'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-fill-hover',
            voice.state === 'recording' ? 'text-function-error' : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {voice.state === 'transcribing' ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
        </button>

        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label={t('Stop')}
            title={t('Stop')}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-text-onblack transition-opacity hover:opacity-90"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : canSend ? (
          <button
            type="button"
            onClick={() => void submit()}
            aria-label={t('Send')}
            title={t('Send')}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-text-onblack transition-opacity hover:opacity-90"
          >
            <ArrowUp className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleVoiceMode}
            aria-label={t(voiceModeOn ? 'Stop voice mode' : 'Voice mode')}
            aria-pressed={voiceModeOn}
            title={t(voiceModeOn ? 'Stop voice mode' : 'Voice mode')}
            className={clsx(
              'flex size-9 shrink-0 items-center justify-center rounded-full bg-text-primary transition-opacity hover:opacity-90',
              voiceModeOn ? 'text-icon-blue' : 'text-text-onblack',
            )}
          >
            <VoiceIcon className="size-4" />
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const incoming = e.target.files;
          if (incoming) setFiles((prev) => [...prev, ...Array.from(incoming)]);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
