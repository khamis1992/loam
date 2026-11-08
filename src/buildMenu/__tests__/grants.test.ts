import test from 'node:test';
import assert from 'node:assert/strict';
import type { BuildOperation } from '../../../packages/shared/src/buildMenu.js';
import { consumeGrant, issueGrant, resetGrants } from '../grants.js';

const operation: BuildOperation = { action: 'generate' };
const base = {
  projectId: 'app_abcdefghijkl',
  revision: 1,
  planSha256: 'b'.repeat(64),
  operation,
  sessionId: 'session-a',
  expiresAt: Date.now() + 60_000,
};

test('grant matrix rejects the wrong caller and keeps one idempotent use', () => {
  resetGrants();
  const grantId = issueGrant(base);
  assert.equal(grantId.length, 64);
  assert.throws(() => consumeGrant({ ...base, expectedRevision: 1, grantId: 'missing', sessionId: 'session-a' }), { status: 403 });
  assert.throws(() => consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'other' }), { status: 403 });
  assert.throws(() => consumeGrant({ ...base, projectId: 'app_zzzzzzzzzzzz', expectedRevision: 1, grantId, sessionId: 'session-a' }), { status: 403 });
  assert.throws(() => consumeGrant({ ...base, planSha256: 'c'.repeat(64), expectedRevision: 1, grantId, sessionId: 'session-a' }), { status: 403 });
  assert.throws(() => consumeGrant({ ...base, operation: { action: 'preview' }, expectedRevision: 1, grantId, sessionId: 'session-a' }), { status: 403 });
  assert.throws(() => consumeGrant({ ...base, expectedRevision: 2, grantId, sessionId: 'session-a' }), { status: 409 });
  const expired = issueGrant({ ...base, expiresAt: Date.now() - 1 });
  assert.throws(() => consumeGrant({ ...base, expectedRevision: 1, grantId: expired, sessionId: 'session-a', now: Date.now() }), { status: 403 });
  consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'session-a' });
  assert.throws(() => consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'session-a' }), { status: 403 });
});

test('issueGrant rejects a non-finite expiresAt', () => {
  resetGrants();
  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => issueGrant({ ...base, expiresAt }), { message: 'invalid_request', status: 400 });
  }
});

test('a grant cannot outlive ten minutes', () => {
  resetGrants();
  const issued = Date.now();
  const grantId = issueGrant({ ...base, expiresAt: issued + 60 * 60 * 1000 });
  consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'session-a', now: issued + 9 * 60 * 1000 });
  const longer = issueGrant({ ...base, expiresAt: issued + 60 * 60 * 1000 });
  assert.throws(
    () => consumeGrant({ ...base, expectedRevision: 1, grantId: longer, sessionId: 'session-a', now: issued + 11 * 60 * 1000 }),
    { status: 403 },
  );
});
