import type { JobPhase } from '../../packages/shared/src/buildMenu.js';

export type JobEvent = 'start' | 'ready' | 'complete' | 'error'
  | 'cancel' | 'stopped' | 'recover';

const edges: Partial<Record<JobPhase, Partial<Record<JobEvent, JobPhase>>>> = {
  queued: { start: 'starting', cancel: 'cancelled', recover: 'interrupted' },
  starting: { ready: 'running', error: 'failed', cancel: 'stopping', recover: 'interrupted' },
  running: { complete: 'completed', error: 'failed', cancel: 'stopping', recover: 'interrupted' },
  stopping: { stopped: 'cancelled', error: 'cancelled', recover: 'interrupted' },
};

export function nextPhase(from: JobPhase, event: JobEvent): JobPhase {
  const next = edges[from]?.[event];
  if (!next) throw new Error(`invalid_transition:${from}:${event}`);
  return next;
}
