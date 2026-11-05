import { describe, expect, it } from 'vitest';
import { collapseEvents, type RenderableEvent } from '../EventList';
import type { PlanUpdateEvent, ToolUsedEvent } from '@shared/socket';

function plan(id: string, title: string): PlanUpdateEvent {
  return { id, type: 'planUpdate', timestamp: 1, tasks: [{ title, status: 'doing', startedAt: 1 }] };
}

describe('collapseEvents plan updates', () => {
  it('keeps one current plan while preserving tool events', () => {
    const tool: ToolUsedEvent = { id: 'tool-1', type: 'toolUsed', timestamp: 2, tool: 'office_craft', actionId: 'action-1', status: 'success', brief: 'Edited file' };
    const result = collapseEvents([plan('plan-1', 'توليد المحتوى'), tool, plan('plan-2', 'تنسيق الشريحة')] as RenderableEvent[]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'plan-2' });
    expect(result[1]).toMatchObject({ id: 'tool-1' });
  });
});
