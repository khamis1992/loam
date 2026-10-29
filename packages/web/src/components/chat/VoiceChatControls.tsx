'use client';

import { Mic, Volume2, VolumeX } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import type { VoiceChat } from '@/hooks/useVoiceChat';

/**
 * Phase-2 W5: the voice controls that ride the task-page composer — a mic
 * toggle (Arabic WebSpeech recognition with a live interim hint) and an
 * auto-speak toggle for assistant replies. Anything the browser does not
 * support is simply not offered, so the row disappears entirely on engines
 * without either API.
 */
export function VoiceChatControls({ voice }: { voice: VoiceChat }) {
  const { supported } = voice;
  if (!supported.recognition && !supported.synthesis) return null;
  return (
    <div className="mb-1 flex items-center gap-2 px-1 text-sm" data-testid="voice-chat-controls">
      {supported.recognition && (
        <button
          type="button"
          onClick={voice.toggleMic}
          aria-label={t('Talk')}
          aria-pressed={voice.micOn}
          title={t('Talk')}
          data-testid="voice-mic"
          className={clsx(
            'flex size-7 shrink-0 items-center justify-center rounded-full border border-border-main transition-colors hover:bg-fill-hover',
            voice.micOn ? 'bg-fill-hover text-function-error' : 'text-text-secondary',
          )}
        >
          <Mic className="size-4" />
        </button>
      )}
      {voice.interim && (
        <span
          dir="auto"
          aria-live="polite"
          data-testid="voice-interim"
          className="min-w-0 max-w-[60%] truncate text-text-tertiary"
        >
          {voice.interim}
        </span>
      )}
      {voice.error && (
        <span role="alert" title={voice.error} className="max-w-[12rem] truncate text-xs text-function-error">
          {voice.error}
        </span>
      )}
      {voice.speaking && (
        <span data-testid="voice-speaking" className="animate-pulse text-xs text-icon-blue">
          {t('Speaking')}
        </span>
      )}
      <div className="flex-1" />
      {supported.synthesis && (
        <button
          type="button"
          onClick={voice.toggleAutoSpeak}
          aria-label={t('Auto-speak replies')}
          aria-pressed={voice.autoSpeak}
          title={t('Auto-speak replies')}
          data-testid="voice-autospeak"
          className={clsx(
            'flex h-7 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
            voice.autoSpeak
              ? 'border-icon-blue bg-fill-tsp text-icon-blue'
              : 'border-border-main text-text-secondary hover:bg-fill-hover',
          )}
        >
          {voice.autoSpeak ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
        </button>
      )}
    </div>
  );
}
