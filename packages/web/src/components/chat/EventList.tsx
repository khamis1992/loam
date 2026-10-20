import { memo, useMemo, Fragment } from 'react';
import type { ChatEvent, ToolUsedEvent, CascadeTaskClockEvent } from '@shared/socket';
import { t, PRODUCT } from '@/i18n/t';
import { Markdown } from './Markdown';
import { UserBubble } from './ChatBubble';
import { ToolUsedRow } from './ToolUsedRow';
import { StatusUpdateRow } from './StatusUpdateRow';
import { PlanStepRow, PlanUpdateRow } from './PlanStep';
import { ApprovalCard, ExecutionApprovalCard, type LocalExecutionApprovalRequested } from '@/components/approval';
import { summarizeTools } from './toolLabels';
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
  const summary = useMemo(() => {
    const tools = collapsed.filter((e): e is ToolUsedEvent => e.type === 'toolUsed');
    return tools.length > 0 ? summarizeTools(tools) : '';
  }, [collapsed]);
  const firstToolIndex = useMemo(() => collapsed.findIndex((e) => e.type === 'toolUsed'), [collapsed]);

  return (
    <ol className="mx-auto flex w-full max-w-[768px] flex-col gap-2 px-[var(--ui-content-padding-x,24px)] py-6">
      {collapsed.map((e, i) => {
        const isTool = e.type === 'toolUsed';
        const row = (
          <li
            key={e.id}
            className={isTool ? 'ms-5 cursor-pointer' : undefined}
            onClick={isTool ? () => onOpenComputer?.(e as ToolUsedEvent) : undefined}
          >
            <Row e={e} sessionId={sessionId} socket={socket} />
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
      })}
    </ol>
  );
}

const FINAL_TOOL_STATUSES = new Set<ToolUsedEvent['status']>(['success', 'error', 'failed', 'cancelled', 'stopped', 'rollback']);

/** Merge toolUsed argument/start/finish frames for the same action into a single event. */
function collapseEvents(events: RenderableEvent[]): RenderableEvent[] {
  const out: RenderableEvent[] = [];
  const indexByAction = new Map<string, number>();
  const hasClosedClock = events.some((e) => e.type === 'cascadeTaskClock' && (e as unknown as CascadeTaskClockEvent).clock?.phase === 'closed');

  for (const e of events) {
    if (e.type === 'toolUsed') {
      const t = e as ToolUsedEvent;
      const idx = indexByAction.get(t.actionId);
      if (idx !== undefined) {
        const existing = out[idx] as ToolUsedEvent;
        // Update status and merge details, preferring the later (usually final) frame.
        out[idx] = {
          ...existing,
          ...t,
          detail: t.detail ?? existing.detail,
          argumentsDetail: t.argumentsDetail ?? existing.argumentsDetail,
        };
        // If a final result has arrived, force the row out of a spinning state.
        if (FINAL_TOOL_STATUSES.has(t.status)) {
          out[idx] = { ...out[idx], status: t.status };
        }
        continue;
      }
      // If the task is complete and a tool frame never reached a final state, treat it as success
      // so stale spinners are not left behind when the backend finalization event is missed.
      if (hasClosedClock && (t.status === 'running' || t.status === 'argumentsFinished' || t.status === 'streaming' || t.status === 'pending')) {
        out.push({ ...t, status: 'success' });
      } else {
        out.push(t);
      }
      indexByAction.set(t.actionId, out.length - 1);
      continue;
    }
    out.push(e);
  }
  return out;
}
