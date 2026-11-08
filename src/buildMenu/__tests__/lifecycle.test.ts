import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPhase } from '../lifecycle.js';

test('cancel never becomes running again', () => {
  assert.equal(nextPhase('starting', 'cancel'), 'stopping');
  assert.equal(nextPhase('stopping', 'stopped'), 'cancelled');
  assert.throws(() => nextPhase('cancelled', 'ready'), /invalid_transition/);
});

test('an unknown job event is rejected', () => {
  assert.throws(() => nextPhase('queued', 'explode' as 'start'), /invalid_transition:queued:explode/);
});

test('readiness, failure, restart recovery', () => {
  assert.equal(nextPhase('queued', 'start'), 'starting');
  assert.equal(nextPhase('starting', 'ready'), 'running');
  assert.equal(nextPhase('running', 'complete'), 'completed');
  assert.equal(nextPhase('starting', 'error'), 'failed');
  assert.equal(nextPhase('running', 'recover'), 'interrupted');
});
