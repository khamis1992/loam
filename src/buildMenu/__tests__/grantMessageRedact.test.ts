import test from 'node:test';
import assert from 'node:assert/strict';
import type { BuildOperation } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError, consumeGrant, grantedCellHash, issueGrant, resetGrants } from '../grants.js';

const operation: BuildOperation = { action: 'generate' };
const base = {
  projectId: 'app_abcdefghijkl',
  revision: 1,
  planSha256: 'b'.repeat(64),
  operation,
  sessionId: 'session-a',
  expiresAt: Date.now() + 60_000,
};

function thrownMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '';
}

function assertGrantOmitted(error: unknown, grantId: string): boolean {
  const message = thrownMessage(error);
  assert.notEqual(message, '');
  assert.equal(message.includes(grantId), false);
  if (error instanceof Error) assert.equal(error.message.includes(grantId), false);
  return true;
}

test('a failed consume or mismatch omits the grant hex', () => {
  resetGrants();
  const grantId = issueGrant(base);
  assert.equal(grantId.length, 64);
  const mismatches = [
    () => consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'other' }),
    () => consumeGrant({ ...base, projectId: 'app_zzzzzzzzzzzz', expectedRevision: 1, grantId, sessionId: 'session-a' }),
    () => consumeGrant({ ...base, planSha256: 'c'.repeat(64), expectedRevision: 1, grantId, sessionId: 'session-a' }),
    () => consumeGrant({ ...base, operation: { action: 'preview' }, expectedRevision: 1, grantId, sessionId: 'session-a' }),
    () => consumeGrant({ ...base, operation: { action: 'package', format: 'web-zip' }, expectedRevision: 1, grantId, sessionId: 'session-a' }),
    () => consumeGrant({ ...base, expectedRevision: 2, grantId, sessionId: 'session-a' }),
  ];
  for (const run of mismatches) {
    assert.throws(run, (error: unknown) => assertGrantOmitted(error, grantId));
  }

  const missing = 'd'.repeat(64);
  assert.notEqual(missing, grantId);
  assert.throws(
    () => consumeGrant({ ...base, expectedRevision: 1, grantId: missing, sessionId: 'session-a' }),
    (error: unknown) => assertGrantOmitted(error, missing),
  );

  const expired = issueGrant({ ...base, expiresAt: Date.now() - 1 });
  assert.throws(
    () => consumeGrant({ ...base, expectedRevision: 1, grantId: expired, sessionId: 'session-a', now: Date.now() }),
    (error: unknown) => assertGrantOmitted(error, expired),
  );

  consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'session-a' });
  assert.throws(
    () => consumeGrant({ ...base, expectedRevision: 1, grantId, sessionId: 'session-a' }),
    (error: unknown) => assertGrantOmitted(error, grantId),
  );

  const kernel = issueGrant({
    ...base,
    operation: { action: 'kernel-execute', cellId: 'cell-1' },
    sourceHash: 'f'.repeat(64),
  });
  assert.throws(
    () => grantedCellHash({ grantId: kernel, sessionId: 'session-a', projectId: base.projectId, cellId: 'other-cell' }),
    (error: unknown) => assertGrantOmitted(error, kernel),
  );
  assert.throws(
    () => grantedCellHash({ grantId: kernel, sessionId: 'other', projectId: base.projectId, cellId: 'cell-1' }),
    (error: unknown) => assertGrantOmitted(error, kernel),
  );
});

test('an ordinary invalid_request message stays readable', () => {
  resetGrants();
  const planSha256 = 'a'.repeat(64);
  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => issueGrant({ ...base, planSha256, expiresAt }),
      (error: unknown) => {
        assert.ok(error instanceof BuildMenuError);
        assert.equal(error.message, 'invalid_request');
        assert.equal(error.status, 400);
        return true;
      },
    );
  }
});
