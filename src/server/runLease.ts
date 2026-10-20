import { allEntities, getEntity, putEntity, transaction } from "./sqliteStore.js";

export const LEASE_KIND = "run-leases";
export const LEASE_TTL_MS = 60_000;
export const LEASE_HEARTBEAT_MS = 15_000;
export const RUNNER_ID = `${process.pid}:${Date.now().toString(36)}`;

export interface RunLease {
  id: string;
  taskId: string;
  owner: string;
  token: number;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

function currentLease(taskId: string): RunLease | undefined {
  return getEntity<RunLease>(LEASE_KIND, taskId);
}

function isCurrent(current: RunLease | undefined, lease: RunLease, now: number): current is RunLease {
  return Boolean(
    current &&
      current.owner === lease.owner &&
      current.token === lease.token &&
      current.expiresAt > now,
  );
}

export function claimRunLease(taskId: string, owner = RUNNER_ID, now = Date.now()): RunLease {
  return transaction(() => {
    const current = currentLease(taskId);
    if (current && current.owner === owner && current.expiresAt > now) return current;
    if (current && current.expiresAt > now) {
      throw new Error(
        `task ${taskId} is already leased by ${current.owner} until ${new Date(current.expiresAt).toISOString()}`,
      );
    }
    const lease: RunLease = {
      id: taskId,
      taskId,
      owner,
      token: (current?.token ?? 0) + 1,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + LEASE_TTL_MS,
    };
    putEntity(LEASE_KIND, lease);
    return lease;
  });
}

export function renewRunLease(lease: RunLease, now = Date.now()): RunLease {
  return transaction(() => {
    const current = currentLease(lease.taskId);
    if (!isCurrent(current, lease, now)) {
      throw new Error(`lease for task ${lease.taskId} is no longer held by ${lease.owner} (token ${lease.token})`);
    }
    const renewed: RunLease = { ...current, renewedAt: now, expiresAt: now + LEASE_TTL_MS };
    putEntity(LEASE_KIND, renewed);
    return renewed;
  });
}

export function assertRunLease(lease: RunLease, now = Date.now()): void {
  const current = currentLease(lease.taskId);
  if (!isCurrent(current, lease, now)) {
    throw new Error(`lease for task ${lease.taskId} is no longer held by ${lease.owner} (token ${lease.token})`);
  }
}

export function releaseRunLease(lease: RunLease, now = Date.now()): void {
  transaction(() => {
    const current = currentLease(lease.taskId);
    if (!current || current.owner !== lease.owner || current.token !== lease.token) return;
    const tombstone: RunLease = { ...current, renewedAt: now, expiresAt: 0 };
    putEntity(LEASE_KIND, tombstone);
  });
}

export function expireRunLease(taskId: string, now = Date.now()): RunLease | undefined {
  return transaction(() => tombstoneRunLease(taskId, now));
}

/** Tombstone a lease without opening a transaction — safe inside an existing one. */
function tombstoneRunLease(taskId: string, now: number): RunLease | undefined {
  const current = currentLease(taskId);
  if (!current || current.expiresAt === 0) return current;
  const tombstone: RunLease = { ...current, renewedAt: now, expiresAt: 0 };
  putEntity(LEASE_KIND, tombstone);
  return tombstone;
}

/** Boot-only: tombstone every lease so stale runners can no longer hold a fiduciary claim. */
export function expireAllRunLeases(now = Date.now()): number {
  return transaction(() => {
    let count = 0;
    for (const lease of allEntities<RunLease>(LEASE_KIND)) {
      if (lease.expiresAt === 0) continue;
      tombstoneRunLease(lease.taskId, now);
      count++;
    }
    return count;
  });
}

export interface LeaseHeartbeat {
  lease(): RunLease;
  stop(): void;
}

/** Renew the lease every LEASE_HEARTBEAT_MS; stop and report once it is lost. */
export function startLeaseHeartbeat(initial: RunLease, onLost?: (error: unknown) => void, intervalMs = LEASE_HEARTBEAT_MS): LeaseHeartbeat {
  let current = initial;
  const timer = setInterval(() => {
    try {
      current = renewRunLease(current);
    } catch (error) {
      clearInterval(timer);
      onLost?.(error);
    }
  }, intervalMs);
  timer.unref?.();
  return { lease: (): RunLease => current, stop: (): void => { clearInterval(timer); } };
}

export function getRunLease(taskId: string): RunLease | undefined {
  return currentLease(taskId);
}

export function isLeaseLive(lease: RunLease | undefined, now = Date.now()): boolean {
  return Boolean(lease && lease.expiresAt > now);
}
