'use client';

import { useMemo, useState } from 'react';
import type { ChatEvent, ToolStatus, ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { humanizeToolName } from './toolLabels';

/** One unified step in the session timeline, derived from the event stream. */
export interface TimelineStep {
  actionId: string;
  tool: string;
  brief: string;
  status: ToolStatus;
  timestamp: number;
  message?: { action?: string; param?: Record<string, unknown> | string };
  argumentsDetail?: Record<string, unknown>;
  index: number;
}

/** Merge the toolUsed argument/start/finish frames for each action into one step. */
export function deriveTimelineSteps(events: ChatEvent[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const indexByAction = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'toolUsed') continue;
    const ev = e as ToolUsedEvent;
    const idx = indexByAction.get(ev.actionId);
    if (idx !== undefined) {
      const prev = steps[idx]!;
      steps[idx] = {
        ...prev,
        status: ev.status,
        brief: ev.brief ?? prev.brief,
        message: ev.message ?? prev.message,
        argumentsDetail: ev.argumentsDetail ?? prev.argumentsDetail,
      };
      continue;
    }
    indexByAction.set(ev.actionId, steps.length);
    steps.push({
      actionId: ev.actionId,
      tool: ev.tool,
      brief: ev.brief ?? '',
      status: ev.status,
      timestamp: ev.timestamp,
      message: ev.message,
      argumentsDetail: ev.argumentsDetail,
      index: steps.length,
    });
  }
  return steps;
}

function stepOutput(step: TimelineStep): string {
  const parts: string[] = [];
  if (step.message?.action) parts.push(String(step.message.action));
  const param = step.message?.param;
  if (typeof param === 'string' && param.trim()) parts.push(param);
  else if (param && typeof param === 'object') parts.push(JSON.stringify(param));
  if (step.argumentsDetail && Object.keys(step.argumentsDetail).length > 0) {
    parts.push(JSON.stringify(step.argumentsDetail));
  }
  return parts.join('\n');
}

interface StepTimelineProps {
  events: ChatEvent[];
  /** Currently selected step action id (time-travel cursor). */
  selectedActionId?: string | null;
  onSelect?: (step: TimelineStep) => void;
}

/**
 * Unified step timeline (shell commands, file edits, browser actions) with
 * time-travel: selecting a step greys every later step and shows that step's
 * state/output. Steps are read from the existing event stream.
 */
export function StepTimeline({ events, selectedActionId, onSelect }: StepTimelineProps) {
  const steps = useMemo(() => deriveTimelineSteps(events), [events]);
  // Uncontrolled fallback so clicking works even before a parent wires the
  // cursor; a supplied `selectedActionId` always wins.
  const [internalCursor, setInternalCursor] = useState<string | null>(null);
  if (steps.length === 0) return null;

  const cursor = selectedActionId ?? internalCursor;
  const selectedIndex = steps.findIndex((s) => s.actionId === cursor);
  const selected = selectedIndex >= 0 ? steps[selectedIndex]! : undefined;
  const output = selected ? stepOutput(selected) : '';

  const select = (step: TimelineStep) => {
    setInternalCursor(step.actionId);
    onSelect?.(step);
  };

  return (
    <div data-testid="step-timeline" className="mx-auto w-full max-w-[768px] px-[var(--ui-content-padding-x,24px)] py-2">
      <div className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">{t('Steps')}</div>
      <ol className="flex flex-wrap items-center gap-1">
        {steps.map((step, i) => {
          const isSelected = step.actionId === cursor;
          const isFuture = selectedIndex >= 0 && i > selectedIndex;
          return (
            <li key={step.actionId}>
              <button
                type="button"
                data-action-id={step.actionId}
                data-testid={`step-${i}`}
                aria-selected={isSelected}
                aria-disabled={isFuture}
                aria-label={humanizeToolName(step.tool)}
                title={humanizeToolName(step.tool)}
                onClick={() => select(step)}
                className={[
                  'flex h-7 items-center gap-1 rounded-control px-2 text-xs',
                  isSelected ? 'bg-icon-blue/15 text-text-primary ring-1 ring-icon-blue/40' : 'bg-fill-tsp text-text-secondary hover:bg-fill-hover',
                  isFuture ? 'opacity-40' : '',
                ].filter(Boolean).join(' ')}
              >
                <span className="text-text-tertiary">{i + 1}</span>
                <span className="truncate">{humanizeToolName(step.tool)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {selected && (
        <div data-testid="step-detail" className="mt-2 rounded-control bg-fill-tsp px-3 py-2 text-xs text-text-secondary">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-medium text-text-primary">{humanizeToolName(selected.tool)}</span>
            <span className="text-text-tertiary">{selected.brief}</span>
          </div>
          {output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-text-tertiary">{output}</pre>}
        </div>
      )}
    </div>
  );
}
