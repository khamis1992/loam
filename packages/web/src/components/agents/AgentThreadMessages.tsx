'use client';

import { Fragment, useMemo } from 'react';
import clsx from 'clsx';
import type { ChatEvent, ChatMessageEvent, ToolUsedEvent } from '@shared/socket';
import { t, getLocale } from '@/i18n/t';
import { Markdown } from '@/components/chat/Markdown';
import { CopyMessageButton } from '@/components/chat/CopyMessageButton';
import { GrokBotNote, grokBotNoteText, isGrokBotNote } from '@/components/chat/GrokBotNote';
import { AttachmentChip } from '@/components/chat/AttachmentChip';
import { ChatEventRow, collapseEvents, type RenderableEvent } from '@/components/chat/EventList';
import { summarizeTools } from '@/components/chat/toolLabels';
import type { ChatSocket } from '@/services/chatSocket';
import { bubbleAlignClass, separatorLabel, shouldInsertSeparator } from './agentThreadLayout';

export interface AgentThreadMessagesProps {
  events: ChatEvent[];
  sessionId: string;
  socket?: ChatSocket | null;
  running?: boolean;
  onOpenComputer?: (e: ToolUsedEvent) => void;
  /** Optional `now` override for separator labels (defaults to Date.now()). */
  now?: number;
}

/** Near-black user bubble (light) that stays readable on dark surfaces. */
function UserBubble({ e }: { e: ChatMessageEvent }) {
  return (
    <div className="group relative flex flex-col gap-2">
      {e.attachments.map((a) => (
        <AttachmentChip key={a.id} name={a.filename} kind={a.contentType} size={a.contentLength} />
      ))}
      <CopyMessageButton text={e.content} align="end" />
      <div
        className={clsx(
          'w-fit max-w-[80%] rounded-2xl bg-[#1a1a19] px-4 py-2.5 shadow-card dark:bg-[#2b2b2b]',
          bubbleAlignClass('user'),
        )}
      >
        <div dir="auto" className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-white">
          {e.content}
        </div>
      </div>
    </div>
  );
}

/** Light grey agent card (left aligned). */
function AgentBubble({ e }: { e: ChatMessageEvent }) {
  return (
    <div className="group relative flex flex-col gap-2">
      <CopyMessageButton text={e.content} />
      <div
        className={clsx(
          'w-fit max-w-[80%] rounded-2xl bg-[var(--background-chat-reaction)] px-4 py-2.5',
          bubbleAlignClass('assistant'),
        )}
      >
        <div dir="auto" className="text-[15px] leading-relaxed text-text-primary">
          <Markdown className="[&>div]:max-w-none">{e.content}</Markdown>
        </div>
      </div>
    </div>
  );
}

function renderChat(e: ChatMessageEvent) {
  if (e.sender === 'user' && isGrokBotNote(e.content)) {
    return <GrokBotNote text={grokBotNoteText(e.content)} />;
  }
  return e.sender === 'user' ? <UserBubble e={e} /> : <AgentBubble e={e} />;
}

function ThreadSeparator({ ts, now, locale }: { ts: number; now: number; locale: string }) {
  return (
    <li aria-hidden="true" className="flex justify-center py-1 select-none">
      <span className="text-xs text-text-tertiary">
        {separatorLabel(ts, now, locale, { today: t('Today'), yesterday: t('Yesterday') })}
      </span>
    </li>
  );
}

function ThreadTypingPill() {
  return (
    <li className="flex justify-start">
      <span className="inline-flex items-center gap-2 rounded-full bg-[var(--background-chat-reaction)] px-3 py-1.5 text-xs text-text-tertiary">
        <span className="flex items-center gap-1" aria-hidden="true">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </span>
        {t('Making progress')}
      </span>
    </li>
  );
}

/**
 * Grok-style agent message list: user bubbles right, agent cards left,
 * centered day/time separators, and a "Making progress" pill while running.
 * Non-chat events (tools, plans, approvals, attachments) reuse the shared
 * EventList row renderer.
 */
export function AgentThreadMessages({
  events,
  sessionId,
  socket,
  running,
  onOpenComputer,
  now,
}: AgentThreadMessagesProps) {
  const collapsed = useMemo(() => collapseEvents(events as unknown as RenderableEvent[]), [events]);
  const summary = useMemo(() => {
    const tools = collapsed.filter((e): e is ToolUsedEvent => e.type === 'toolUsed');
    return tools.length > 0 ? summarizeTools(tools) : '';
  }, [collapsed]);
  const firstToolIndex = useMemo(() => collapsed.findIndex((e) => e.type === 'toolUsed'), [collapsed]);
  const effectiveNow = now ?? Date.now();
  const locale = getLocale();

  let lastChatTs: number | null = null;
  let anchored = false;

  const rows = collapsed.map((e, i) => {
    const isChat = e.type === 'chat';
    // The first chat message anchors the thread with a leading separator.
    const showLeading = isChat && !anchored;
    const needSeparator = isChat && (showLeading || shouldInsertSeparator(lastChatTs, e.timestamp));
    if (isChat) {
      anchored = true;
      lastChatTs = e.timestamp;
    }

    if (isChat) {
      return (
        <Fragment key={e.id}>
          {needSeparator && <ThreadSeparator ts={e.timestamp} now={effectiveNow} locale={locale} />}
          <li>
            <ChatEventRow
              e={e}
              sessionId={sessionId}
              socket={socket}
              renderChat={(c) => renderChat(c as ChatMessageEvent)}
            />
          </li>
        </Fragment>
      );
    }

    const isTool = e.type === 'toolUsed';
    const row = (
      <li
        className={isTool ? 'ms-5 cursor-pointer' : undefined}
        onClick={isTool ? () => onOpenComputer?.(e as ToolUsedEvent) : undefined}
      >
        <ChatEventRow e={e} sessionId={sessionId} socket={socket} />
      </li>
    );
    if (i === firstToolIndex && summary) {
      return (
        <Fragment key={`summary-${e.id}`}>
          <li className="text-sm text-text-tertiary">
            {summary} <span aria-hidden="true">›</span>
          </li>
          {row}
        </Fragment>
      );
    }
    return row;
  });

  return (
    <ol className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 pt-4 pb-2">
      {rows}
      {running && <ThreadTypingPill />}
    </ol>
  );
}
