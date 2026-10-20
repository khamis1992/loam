import { memo, useMemo } from 'react';
import type { ChatEvent, ToolUsedEvent, CascadeTaskClockEvent } from '@shared/socket';
import { t, PRODUCT } from '@/i18n/t';
import { Markdown } from './Markdown';
import { UserBubble } from './ChatBubble';
import { ToolUsedRow } from './ToolUsedRow';
import { StatusUpdateRow } from './StatusUpdateRow';
import { PlanStepRow, PlanUpdateRow } from './PlanStep';
import { ApprovalCard, ExecutionApprovalCard, type LocalExecutionApprovalRequested } from '@/components/approval';
import type { ChatSocket } from '@/services/chatSocket';

type RenderableEvent = ChatEvent | LocalExecutionApprovalRequested;

interface EventListProps {
  events: ChatEvent[];
  sessionId: string;
  socket?: ChatSocket | null;
  onOpenComputer?: (e: ToolUsedEvent) => void;
}

const Row = memo(function Row({ e, sessionId, socket }: { e: RenderableEvent; sessionId: string; socket?: ChatSocket | null }) {
  switch (e.type) {
    case 'chat':
      return e.sender === 'user'
        ? <UserBubble event={e} />
        : <Markdown className="text-base text-text-primary">{e.content}</Markdown>;
    case 'newPlanStep':
      return <PlanStepRow e={e} />;
    case 'planUpdate':
      return <PlanUpdateRow e={e} />;
    case 'toolUsed':
      return <ToolUsedRow e={e as ToolUsedEvent} />;
    case 'statusUpdate':
      return <StatusUpdateRow e={e} />;
    case 'explanation':
      return <p className="text-sm text-text-secondary">{e.content}</p>;
    case 'liveStatus':
      return <div className="text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>;
    case 'userStop':
      return <div className="text-sm text-text-tertiary">{t('Stopped')} — {t('send message to continue', { productName: PRODUCT })}</div>;
    case 'folderAccessRequest':
      return (
        <ApprovalCard
          request={e}
          onRespond={(decision) => {
            if (decision === 'always') {
              // "Always allow" is handled by the desktop operator layer; fall back to once here.
              socket?.submitWorkspaceDirectoryAccess(sessionId, e.requestId, true);
              return;
            }
            socket?.submitWorkspaceDirectoryAccess(sessionId, e.requestId, decision === 'once');
          }}
        />
      );
    case 'localExecutionApprovalRequested':
      return (
        <ExecutionApprovalCard
          request={e}
          onResolve={(resolution) => socket?.resolveLocalExecutionApproval(sessionId, e.requestId, resolution)}
        />
      );
    case 'chatDelta':
    case 'cascadeTaskClock':
    case 'queueStatusChange':
    case 'desktopSessionConfig':
    case 'desktopDevicesUpdate':
    case 'localPermissionModeChangeResult':
    case 'eventsNotifyEventsAfter':
      return null;
    default:
      return <div className="text-xs text-text-disable">{(e as { type: string }).type}</div>;
  }
});

export function EventList({ events, sessionId, socket, onOpenComputer }: EventListProps) {
  const collapsed = useMemo(() => collapseEvents(events as unknown as RenderableEvent[]), [events]);
  return (
    <ol className="mx-auto flex w-full max-w-[768px] flex-col gap-2 px-[var(--ui-content-padding-x,24px)] py-6">
      {collapsed.map((e) => {
        const isTool = e.type === 'toolUsed';
        return (
          <li
            key={e.id}
            className={isTool ? 'ms-5 cursor-pointer' : undefined}
            onClick={isTool ? () => onOpenComputer?.(e as ToolUsedEvent) : undefined}
          >
            <Row e={e} sessionId={sessionId} socket={socket} />
          </li>
        );
      })}
    </ol>
  );
}

/** Merge toolUsed argument/start/finish frames for the same action into a single event. */
function collapseEvents(events: RenderableEvent[]): RenderableEvent[] {
  const out: RenderableEvent[] = [];
  const toolByAction = new Map<string, ToolUsedEvent>();
  const hasClosedClock = events.some((e) => e.type === 'cascadeTaskClock' && (e as unknown as CascadeTaskClockEvent).clock?.phase === 'closed');
  for (const e of events) {
    if (e.type === 'toolUsed') {
      const t = e as ToolUsedEvent;
      const existing = toolByAction.get(t.actionId);
      if (existing) {
        // Update status and merge details, preferring the later (usually final) frame.
        toolByAction.set(t.actionId, {
          ...existing,
          ...t,
          detail: t.detail ?? existing.detail,
          argumentsDetail: t.argumentsDetail ?? existing.argumentsDetail,
        });
        continue;
      }
      // If the task is complete and a tool frame never reached a final state, treat it as success
      // so stale spinners are not left behind when the backend finalization event is missed.
      if (hasClosedClock && (t.status === 'running' || t.status === 'argumentsFinished')) {
        toolByAction.set(t.actionId, { ...t, status: 'success' });
      } else {
        toolByAction.set(t.actionId, t);
      }
      out.push(toolByAction.get(t.actionId)!);
      continue;
    }
    out.push(e);
  }
  return out;
}
