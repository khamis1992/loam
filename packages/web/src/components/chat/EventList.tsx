import { memo } from 'react';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
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
      return <div className="text-sm text-text-tertiary">{t('{productName} stopped — send message to continue', { productName: PRODUCT })}</div>;
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

export function EventList({ events, sessionId, socket }: EventListProps) {
  const renderable = events as unknown as RenderableEvent[];
  return (
    <ol className="mx-auto flex w-full max-w-[768px] flex-col gap-2 px-[var(--ui-content-padding-x,24px)] py-6">
      {renderable.map((e) => <li key={e.id}><Row e={e} sessionId={sessionId} socket={socket} /></li>)}
    </ol>
  );
}
