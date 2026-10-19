'use client';

import { useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import {
  Share, FileChartColumn, MoreHorizontal, PanelRight, CircleCheck, Copy, Repeat2,
  Star,
} from 'lucide-react';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store';
import { appendEvent, setStatus } from '@/store/chatSlice';
import { addSession, selectSession } from '@/store/sessionsSlice';
import { t, PRODUCT } from '@/i18n/t';
import { Composer } from '@/components/chat/Composer';
import { EventList } from '@/components/chat/EventList';
import type { TaskMode, ChatMessageEvent, StatusUpdateEvent, ToolUsedEvent, CascadeTaskClockEvent, ChatDeltaEvent } from '@shared/socket';
import { formatDuration, formatTime } from '@/utils/format';

export default function TaskPageClient(_props: { params: Promise<{ sessionUid: string }> }) {
  const { sessionUid } = useParams() as { sessionUid: string };
  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();
  const events = useAppSelector((s) => s.chat.eventsBySession[sessionUid] ?? []);
  const status = useAppSelector((s) => s.chat.statusBySession[sessionUid]);
  const running = useAppSelector((s) => s.chat.running[sessionUid] ?? false);
  const draftText = searchParams.get('draft') || '';
  const draftMode = (searchParams.get('mode') as TaskMode) || 'standard';

  useEffect(() => {
    if (draftText) {
      const userEvent: ChatMessageEvent = {
        id: `draft-${sessionUid}`,
        type: 'chat',
        timestamp: Date.now(),
        sender: 'user',
        messageType: 'text',
        content: draftText,
        attachments: [],
      };
      dispatch(appendEvent({ sessionId: sessionUid, event: userEvent }));
      dispatch(addSession({
        uid: sessionUid, title: draftText.slice(0, 60), status: 6,
        lastMessageTime: Date.now(), lastDisplayMessage: draftText, icon: '•',
      }));
      dispatch(selectSession(sessionUid));
      dispatch(setStatus({ sessionId: sessionUid, status: 'running' }));
      setTimeout(() => completeDemo(sessionUid, dispatch), 1200);
    }
  }, [sessionUid, draftText, dispatch]);

  const clockEvent = useMemo(() =>
    [...events].reverse().find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock'),
  [events]);

  const assistantText = useMemo(() => {
    const final = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant');
    return final?.content ?? '';
  }, [events]);

  const handleSend = (text: string, mode: TaskMode, _files: File[]) => {
    const userEvent: ChatMessageEvent = {
      id: `msg-${Date.now()}`,
      type: 'chat',
      timestamp: Date.now(),
      sender: 'user',
      messageType: 'text',
      content: text,
      attachments: [],
    };
    dispatch(appendEvent({ sessionId: sessionUid, event: userEvent }));
    dispatch(setStatus({ sessionId: sessionUid, status: 'running' }));
    setTimeout(() => completeDemo(sessionUid, dispatch, text), 1200);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-row items-center justify-end gap-2 px-6">
        <button className="flex h-row-sm items-center gap-1 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover">
          <Share className="size-4" /> {t('Share')}
        </button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><FileChartColumn className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><MoreHorizontal className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><PanelRight className="size-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[768px] px-6 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">◉</span>
            <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
          </div>
          {running && <div className="mb-2 text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>}
          {clockEvent && !running && (
            <div className="mb-2 text-sm text-text-tertiary">
              {t('Worked for {duration}', { duration: formatDuration(clockEvent.clock.accumulatedMs) })} ›
            </div>
          )}
          <EventList events={events} />

          {assistantText && !running && (
            <div className="mx-auto w-full max-w-[768px] px-[var(--ui-content-padding-x,24px)]">
              <div className="mb-2 flex items-center gap-2 text-sm text-func-success">
                <CircleCheck className="size-4" /> {t('Task completed')}
              </div>
              <div className="mb-4 flex items-center gap-2 text-sm text-text-tertiary">
                <button className="rounded-control p-1 hover:bg-fill-hover"><Copy className="size-4" /></button>
                <button className="rounded-control p-1 hover:bg-fill-hover"><Repeat2 className="size-4" /></button>
                <span className="ms-auto">{formatTime(Date.now())}</span>
              </div>
              <div className="mb-2 flex items-center gap-2 text-sm text-text-secondary">
                <span className="ms-auto">{t('How was this result?')}</span>
                {[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-4 text-[#d4d4d4]" />)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[768px] px-6 pb-4">
        <div className="mb-2 flex h-row-sm items-center gap-2 rounded-control bg-fill-tsp px-2 text-sm text-text-secondary">
          <span className={running ? 'animate-pulse text-icon-blue' : status === 'stopped' ? 'text-function-warning' : 'text-func-success'}>
            {running ? '●' : status === 'stopped' ? '◼' : '✓'}
          </span>
          {running ? t('Working') : status === 'stopped' ? t('Stopped') : t('Task completed')}
        </div>
        <Composer onSend={handleSend} onStop={() => dispatch(setStatus({ sessionId: sessionUid, status: 'stopped' }))} running={running} />
      </div>
    </div>
  );
}

function completeDemo(sessionId: string, dispatch: AppDispatch, text = 'hello') {
  const delta: ChatDeltaEvent = {
    id: `delta-${Date.now()}`,
    type: 'chatDelta',
    timestamp: Date.now(),
    sender: 'assistant',
    taskMode: 'standard',
    qualityMode: 'standard',
    deliveryKind: 'provisional',
    delta: { content: `Received: ${text}` },
    finished: true,
    rollback: false,
    targetEventId: `assistant-${sessionId}`,
  };
  dispatch(appendEvent({ sessionId, event: delta }));
  const assistant: ChatMessageEvent = {
    id: `assistant-${sessionId}`,
    type: 'chat',
    timestamp: Date.now(),
    sender: 'assistant',
    messageType: 'text',
    content: `Received: ${text}`,
    attachments: [],
  };
  dispatch(appendEvent({ sessionId, event: assistant }));
  const clock: CascadeTaskClockEvent = {
    id: `clock-${Date.now()}`,
    type: 'cascadeTaskClock',
    timestamp: Date.now(),
    clock: {
      sessionId, taskId: sessionId,
      startedAt: Date.now() - 1200,
      accumulatedMs: 1200,
      phase: 'closed',
      revision: 1,
    },
  };
  dispatch(appendEvent({ sessionId, event: clock }));
  const suggestion: ToolUsedEvent = {
    id: `sugg-${Date.now()}`,
    type: 'toolUsed',
    timestamp: Date.now(),
    tool: 'suggestion',
    actionId: 'call_suggestion',
    status: 'success',
    detail: { suggestion: { commands: [
      { content: 'Follow up one', commandType: 'followup_requirement' },
      { content: 'Follow up two', commandType: 'followup_requirement' },
    ] } },
  };
  dispatch(appendEvent({ sessionId, event: suggestion }));
  const statusEvt: StatusUpdateEvent = {
    id: `status-${Date.now()}`,
    type: 'statusUpdate',
    timestamp: Date.now(),
    agentStatus: 'stopped',
    brief: `${PRODUCT} finished working`,
  };
  dispatch(appendEvent({ sessionId, event: statusEvt }));
  dispatch(setStatus({ sessionId, status: 'stopped' }));
}
