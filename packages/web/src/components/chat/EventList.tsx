import { memo } from 'react';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { t, PRODUCT } from '@/i18n/t';
import { Spinner } from '@/components/ui/Button';
import { Markdown } from './Markdown';
import { UserBubble } from './ChatBubble';
import { ToolUsedRow } from './ToolUsedRow';
import { StatusUpdateRow } from './StatusUpdateRow';
import { PlanStepRow, PlanUpdateRow } from './PlanStep';
import { ApprovalCard } from './ApprovalCard';

const Row = memo(function Row({ e }: { e: ChatEvent }) {
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
    case 'chatDelta':
    case 'cascadeTaskClock':
    case 'queueStatusChange':
    case 'planUpdate':
    case 'desktopSessionConfig':
    case 'desktopDevicesUpdate':
    case 'localPermissionModeChangeResult':
    case 'eventsNotifyEventsAfter':
      return null;
    case 'folderAccessRequest':
      return <ApprovalCard request={e} />;
    default:
      return <div className="text-xs text-text-disable">{(e as { type: string }).type}</div>;
  }
});

export function EventList({ events }: { events: ChatEvent[] }) {
  return (
    <ol className="mx-auto flex w-full max-w-[768px] flex-col gap-2 px-[var(--ui-content-padding-x,24px)] py-6">
      {events.map((e) => <li key={e.id}><Row e={e} /></li>)}
    </ol>
  );
}
