import { memo, useMemo, Fragment, type ReactNode } from 'react';
import type { ChatEvent, ToolUsedEvent, CascadeTaskClockEvent, AttachmentEvent, ModeEvent, EnvironmentIssueEvent, CacheUsageEvent } from '@shared/socket';
import { t, PRODUCT } from '@/i18n/t';
import { Markdown } from './Markdown';
import { UserBubble } from './ChatBubble';
import { GrokBotNote, grokBotNoteText, isGrokBotNote } from './GrokBotNote';
import { CopyMessageButton } from './CopyMessageButton';
import { ToolUsedRow } from './ToolUsedRow';
import { StatusUpdateRow } from './StatusUpdateRow';
import { CacheUsageRow } from './CacheUsageRow';
import { PlanStepRow, PlanUpdateRow, TodoListRow } from './PlanStep';
import { ApprovalCard, FolderAccessApprovalCard, PlanApprovalCard, type LocalExecutionApprovalRequested, type PlanApprovalRequested } from '@/components/approval';
import { AttachmentCard } from './AttachmentCard';
import { EnvironmentIssueCard } from './EnvironmentIssueCard';
import { summarizeTools } from './toolLabels';
import type { ChatSocket } from '@/services/chatSocket';

export type RenderableEvent = ChatEvent | LocalExecutionApprovalRequested | PlanApprovalRequested;

interface EventListProps {
  events: ChatEvent[];
  sessionId: string;
  socket?: ChatSocket | null;
  onOpenComputer?: (e: ToolUsedEvent) => void;
}

export interface ChatEventRowProps {
  e: RenderableEvent;
  sessionId: string;
  socket?: ChatSocket | null;
  /** Optional override for chat rows (e.g. Grok-style bubbles in the agent thread). */
  renderChat?: (e: ChatEvent) => ReactNode;
}

/**
 * Renders one event. Chat rows use the default bubble/markdown styling unless
 * a `renderChat` override is supplied, which lets the agent thread restyle
 * messages without duplicating the non-chat event handling.
 */
export function ChatEventRow({ e, sessionId, socket, renderChat }: ChatEventRowProps) {
  if (e.type === 'chat') {
    if (renderChat) return renderChat(e);
    if (e.sender === 'user' && isGrokBotNote(e.content)) {
      // READ-ONLY mirrored note from Grok Bot: muted bubble, chip, no buttons.
      return <GrokBotNote text={grokBotNoteText(e.content)} />;
    }
    return e.sender === 'user'
      ? <div className="group relative"><CopyMessageButton text={e.content} align="end" /><UserBubble event={e} /></div>
      : <div className="group relative"><CopyMessageButton text={e.content} /><Markdown className="text-base text-text-primary">{e.content}</Markdown></div>;
  }
  switch (e.type) {
    case 'newPlanStep':
      return <PlanStepRow e={e} />;
    case 'planUpdate':
      return <PlanUpdateRow e={e} />;
    case 'todoUpdate':
      return <TodoListRow e={e} />;
    case 'toolUsed':
      return <ToolUsedRow e={e as ToolUsedEvent} />;
    case 'statusUpdate':
      return <StatusUpdateRow e={e} />;
    case 'cache_usage':
      return <CacheUsageRow e={e as CacheUsageEvent} />;
    case 'explanation':
      return <p className="text-sm text-text-secondary">{e.content}</p>;
    case 'mode': {
      const mode = e as ModeEvent;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full bg-fill-tsp px-2.5 py-1 text-xs text-text-secondary">
          <span className="font-medium">{mode.label}</span>
          {mode.reason && <span className="text-text-tertiary">· {mode.reason}</span>}
        </div>
      );
    }
    case 'attachment': {
      const a = e as AttachmentEvent;
      return <AttachmentCard name={a.name} mime={a.mime} size={a.sizeBytes} taskId={a.taskId} path={a.path} />;
    }
    case 'environmentIssue': {
      return <EnvironmentIssueCard issue={e as EnvironmentIssueEvent} />;
    }
    case 'liveStatus':
      return <div className="text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>;
    case 'userStop':
      return <div className="text-sm text-text-tertiary">{t('Stopped')} — {t('send message to continue', { productName: PRODUCT })}</div>;
    case 'folderAccessRequest':
      return (
        <FolderAccessApprovalCard
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
        <ApprovalCard
          request={e}
          onRespond={(decision) => {
            // 'always' resolves 'approve' AND asks the server to persist a rule
            // scoped to the task's agent (handled by the resolver endpoint).
            socket?.resolveLocalExecutionApproval(
              sessionId,
              e.requestId,
              decision === 'deny' ? 'deny' : decision === 'always' ? 'always' : 'approve',
            );
          }}
        />
      );
    case 'planApprovalRequested':
      return (
        <PlanApprovalCard
          request={e}
          onRespond={(decision, plan) => {
            socket?.resolvePlanApproval(
              sessionId,
              e.requestId,
              decision,
              decision === 'edit' && plan
                ? { summary: plan.summary, steps: plan.steps, files_to_edit: plan.files_to_edit }
                : undefined,
            );
          }}
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
}

const Row = memo(function Row({ e, sessionId, socket }: { e: RenderableEvent; sessionId: string; socket?: ChatSocket | null }) {
  return <ChatEventRow e={e} sessionId={sessionId} socket={socket} />;
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
export function collapseEvents(events: RenderableEvent[]): RenderableEvent[] {
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
