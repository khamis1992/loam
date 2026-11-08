import { randomBytes } from 'node:crypto';
import type { BuildOperation } from '../../packages/shared/src/buildMenu.js';

export class BuildMenuError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface GrantRecord {
  projectId: string;
  revision: number;
  planSha256: string;
  operation: BuildOperation;
  sessionId: string;
  expiresAt: number;
  consumed: boolean;
  sourceHash?: string;
}

const grants = new Map<string, GrantRecord>();
const GRANT_TTL_MS = 10 * 60 * 1000;

export function issueGrant(input: {
  projectId: string;
  revision: number;
  planSha256: string;
  operation: BuildOperation;
  sessionId: string;
  expiresAt: number;
  sourceHash?: string;
}): string {
  if (!input.sessionId) throw new BuildMenuError('unauthenticated', 403);
  if (!Number.isFinite(input.expiresAt)) throw new BuildMenuError('invalid_request', 400);
  const expiresAt = Math.min(input.expiresAt, Date.now() + GRANT_TTL_MS);
  const id = randomBytes(32).toString('hex');
  grants.set(id, { ...input, expiresAt, consumed: false });
  return id;
}

function sameOperation(left: BuildOperation, right: BuildOperation): boolean {
  switch (left.action) {
    case 'generate':
    case 'preview':
      return right.action === left.action;
    case 'package':
      return right.action === 'package' && right.format === left.format;
    case 'kernel-execute':
      return right.action === 'kernel-execute' && right.cellId === left.cellId;
    default: {
      const unknown: never = left;
      return unknown;
    }
  }
}

export function grantedCellHash(input: { grantId: string; sessionId: string; projectId: string; cellId: string }): string {
  const grant = grants.get(input.grantId);
  if (!grant || grant.consumed || grant.sessionId !== input.sessionId || grant.projectId !== input.projectId || !grant.sourceHash) {
    throw new BuildMenuError('approval_required', 403);
  }
  if (grant.operation.action !== 'kernel-execute' || grant.operation.cellId !== input.cellId) {
    throw new BuildMenuError('approval_required', 403);
  }
  return grant.sourceHash;
}

export function consumeGrant(input: {
  projectId: string;
  expectedRevision: number;
  planSha256: string;
  operation: BuildOperation;
  grantId: string;
  sessionId: string;
  now?: number;
}): void {
  const grant = grants.get(input.grantId);
  const now = input.now ?? Date.now();
  if (!grant || grant.consumed || grant.sessionId !== input.sessionId || grant.projectId !== input.projectId) {
    throw new BuildMenuError('approval_required', 403);
  }
  if (grant.planSha256 !== input.planSha256 || !sameOperation(grant.operation, input.operation)) {
    throw new BuildMenuError('approval_required', 403);
  }
  if (grant.expiresAt <= now) throw new BuildMenuError('approval_required', 403);
  if (grant.revision !== input.expectedRevision) throw new BuildMenuError('stale_revision', 409);
  grant.consumed = true;
}

export function resetGrants(): void {
  grants.clear();
}
