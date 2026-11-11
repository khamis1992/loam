import { describe, expect, it } from 'vitest';
import { groupEvents, type RenderableEvent } from '../EventList';
import type { NewPlanStepEvent, StatusUpdateEvent, ToolUsedEvent } from '@shared/socket';

function step(id: string, title: string): NewPlanStepEvent {
  return { id: `step-${id}`, type: 'newPlanStep', timestamp: 1, stepId: id, title };
}

function tool(id: string, actionId: string, planStepId?: string): ToolUsedEvent {
  return { id, type: 'toolUsed', timestamp: 2, tool: 'file_read', actionId, status: 'success', brief: 'Read file', planStepId };
}

function status(id: string, planStepId?: string): StatusUpdateEvent {
  return { id, type: 'statusUpdate', timestamp: 3, agentStatus: 'waiting', brief: 'Waiting for user...', planStepId };
}

describe('groupEvents', () => {
  it('nests tool and status rows under the matching plan step', () => {
    const result = groupEvents([
      step('a', 'Collect data'),
      tool('t1', 'a1', 'a'),
      tool('t2', 'a2', 'a'),
      status('s1', 'a'),
      step('b', 'Write output'),
      tool('t3', 'a3', 'b'),
    ] as RenderableEvent[]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'group', step: { stepId: 'a' } });
    expect(result[1]).toMatchObject({ kind: 'group', step: { stepId: 'b' } });
    const first = result[0]!;
    if (first.kind !== 'group') throw new Error('expected group');
    expect(first.children.map((c) => c.id)).toEqual(['t1', 't2', 's1']);
    const second = result[1]!;
    if (second.kind !== 'group') throw new Error('expected group');
    expect(second.children.map((c) => c.id)).toEqual(['t3']);
  });

  it('keeps rows without a planStepId top-level', () => {
    const result = groupEvents([
      step('a', 'Collect data'),
      tool('t1', 'a1', 'a'),
      tool('t2', 'a2'),
    ] as RenderableEvent[]);

    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe('group');
    expect(result[1]).toMatchObject({ kind: 'event', event: { id: 't2' } });
  });

  it('keeps rows whose step never opened top-level', () => {
    const result = groupEvents([tool('t1', 'a1', 'missing')] as RenderableEvent[]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'event', event: { id: 't1' } });
  });

  it('keeps a plan update and other top-level rows in order', () => {
    const result = groupEvents([
      { id: 'p1', type: 'planUpdate', timestamp: 1, tasks: [] },
      step('a', 'Collect data'),
      tool('t1', 'a1', 'a'),
    ] as RenderableEvent[]);
    expect(result.map((r) => (r.kind === 'group' ? r.step.id : r.event.id))).toEqual(['p1', 'step-a']);
  });
});
