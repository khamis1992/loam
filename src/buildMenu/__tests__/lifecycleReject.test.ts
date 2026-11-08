import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobPhase } from '../../../packages/shared/src/buildMenu.js';
import { nextPhase, type JobEvent } from '../lifecycle.js';

function phaseAfterRejected(from: JobPhase, event: JobEvent): JobPhase {
  let phase = from;
  assert.throws(
    () => { phase = nextPhase(from, event); },
    (error: unknown) => error instanceof Error && error.message === `invalid_transition:${from}:${event}`,
  );
  return phase;
}

test('an illegal phase transition does not become completed or running', () => {
  const illegal: Array<[JobPhase, JobEvent]> = [
    ['queued', 'ready'],
    ['queued', 'complete'],
    ['starting', 'complete'],
    ['stopping', 'ready'],
    ['stopping', 'complete'],
    ['failed', 'ready'],
    ['failed', 'complete'],
    ['interrupted', 'ready'],
    ['interrupted', 'complete'],
    ['cancelled', 'start'],
    ['cancelled', 'complete'],
  ];
  for (const [from, event] of illegal) {
    const phase = phaseAfterRejected(from, event);
    assert.equal(phase, from);
    assert.notEqual(phase, 'completed');
    assert.notEqual(phase, 'running');
  }
});

test('a late ready after cancelled stays cancelled', () => {
  const phase = phaseAfterRejected('cancelled', 'ready');
  assert.equal(phase, 'cancelled');
  assert.notEqual(phase, 'running');
  assert.notEqual(phase, 'completed');
});
