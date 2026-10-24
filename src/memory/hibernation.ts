/**
 * Idle chat-view memory hibernation (J7), daemon side.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md and its daemon idle monitor:
 * after a sustained idle period the session releases *derived* in-memory state
 * (provider-message caches, reconstructible tool-output indexes, derived
 * projections) while authoritative state — canonical messages, tool definitions,
 * captured instructions, undo state — stays resident. This is not process
 * suspension and it never interrupts a tool, an agent turn, or a scheduled wake.
 *
 * Boundaries that keep it testable and safe:
 * - The clock and the per-session idle deadline are injected, so tests drive the
 *   idle transition deterministically instead of waiting 30 real minutes.
 * - Owners register caches with a name; a release is a bounded `clear()` on each
 *   one. Nothing here knows what the cache holds, so a mis-registration can
 *   never drop authoritative state by accident (see `hibernateSession`).
 * - Guards are explicit: a session with an in-flight run signal (an active tool
 *   or agent turn) is never hibernated, and a session with pending input is
 *   never hibernated. Guards run *after* the elapsed-time requirement, so the
 *   jcode `client:hibernate` test hook still bypasses only the timer.
 * - Every sweep records exactly one before/after pair (J6 `debug:memory`
 *   counters plus this module's counters) and purges retained heap once.
 */
import { collectMemoryProfile, retainedCacheBytes, resetMemoryProfile } from "./profile.js";

/** Released-state owner: one named derived cache a session holds. */
export interface CacheOwner {
  /** Logical name, reported by the hibernation counters. */
  name: string;
  /** The number of entries this owner can currently rebuild. */
  size(): number;
  /** Approximate retained bytes of the derived state (0 when unknown). */
  bytes?(): number;
  /** Drop the derived state. Must never throw: a partial release is fine. */
  clear(): void;
  /** Rebuild is implicit: the next read reconstructs from authoritative state. */
}

export type HibernationState = "active" | "idle" | "hibernated";

export interface HibernationRecord {
  sessionId: string;
  state: HibernationState;
  /** When the session last had work that counts as activity. */
  lastActivityAt: number;
  /** When the session entered `idle` (no work, but not yet reclaimed). */
  idleSince?: number;
  /** When the session was hibernated. */
  hibernatedAt?: number;
  /** When the session was last woken. */
  wokeAt?: number;
  /** How many times this session has hibernated. */
  hibernations: number;
  /** Entries released by the last hibernation. */
  lastReleasedEntries: number;
  /** Estimated bytes released by the last hibernation. */
  lastReleasedBytes: number;
  /** Last release failure, surfaced instead of hidden. */
  lastError?: string;
}

export interface HibernationGuard {
  /** An in-flight run signal (tool or agent turn) must never be reclaimed. */
  running?(): boolean;
  /** Pending input (a draft being typed, a queued prompt) must survive. */
  pendingInput?(): boolean;
  /** A scheduled wake in flight must not be interrupted. */
  scheduledWake?(): boolean;
}

export interface HibernateOptions {
  /** Bypass the elapsed-time requirement for a test hook. Guards still apply. */
  immediate?: boolean;
  /** Force release even when a guard says the session is busy. Tests only. */
  force?: boolean;
}

export interface HibernationHooks {
  /** Called with the released entry/byte estimate, once per sweep. */
  onHibernation?: (record: HibernationRecord, released: { entries: number; bytes: number }) => void;
  onWake?: (record: HibernationRecord) => void;
}

export interface HibernationManagerOptions {
  /** Idle minutes before an idle session hibernates (default 30; 0 disables). */
  idleMinutes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  hooks?: HibernationHooks;
  /** Injectable RSS reader so a bench can measure a spawned process. */
  measureRss?: () => number;
  /** Ask for the heap purge once per sweep (tests inject a spy). */
  purgeHeap?: () => void;
}

export interface HibernationSweepResult {
  sweeps: number;
  hibernated: number;
  entriesReleased: number;
  bytesReleased: number;
  /** One before/after pair for the whole sweep (measured, never assumed). */
  beforeBytes?: number;
  afterBytes?: number;
  rssChangeBytes?: number;
  skipped: Array<{ sessionId: string; reason: string }>;
  purgedHeap: boolean;
}

export const DEFAULT_HIBERNATION_IDLE_MINUTES = 30;

/** 0 disables hibernation; any other positive value is the idle threshold. */
function normalizeIdleMinutes(minutes: number): number {
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 0) * 60_000;
}

/** Per-process counters exposed through the J6 `debug:memory` surface. */
export interface HibernationStats {
  /** Configured idle threshold in minutes (0 = hibernation disabled). */
  idleMinutes: number;
  /** Idle threshold in milliseconds (0 = disabled). */
  idleThresholdMs: number;
  /** True when the disable setting (0) turned the whole feature off. */
  disabled: boolean;
  sessions: number;
  hibernated: number;
  hibernations: number;
  entriesReleased: number;
  bytesReleased: number;
  /** Server-side before/after readings, mirrored to the debug surface. */
  lastSweep?: {
    at: string;
    hibernated: number;
    entriesReleased: number;
    bytesReleased: number;
    beforeBytes: number;
    afterBytes: number;
    rssChangeBytes: number;
    purgedHeap: boolean;
  };
}

/**
 * The daemon's idle hibernation manager. One instance serves the process; the
 * shared instance is wired with real cache owners by `src/index.ts`.
 */
export class HibernationManager {
  private readonly records = new Map<string, HibernationRecord>();
  private readonly owners = new Map<string, CacheOwner[]>();
  private readonly guards = new Map<string, HibernationGuard>();
  private readonly now: () => number;
  private idleMs: number;
  private readonly hooks: HibernationHooks;
  private readonly measureRss: () => number;
  private readonly purgeHeap: () => void;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweeps = 0;
  private closed = false;

  constructor(options: HibernationManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const minutes = options.idleMinutes ?? DEFAULT_HIBERNATION_IDLE_MINUTES;
    this.idleMs = normalizeIdleMinutes(minutes);
    this.hooks = options.hooks ?? {};
    this.measureRss = options.measureRss ?? (() => process.memoryUsage().rss);
    this.purgeHeap = options.purgeHeap ?? (() => {
      // One purge per sweep. `global.gc` only exists under --expose-gc; a
      // missing collector is not an error, the allocator simply keeps its heap.
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc === "function") gc();
    });
  }

  /** Idle after which a session hibernates. 0 means the feature is disabled. */
  get idleThresholdMs(): number {
    return this.idleMs;
  }

  /** Re-configure the idle threshold at runtime (config reload, tests). A
   *  value of 0 disables hibernation and stops the sweep; a positive value
   *  re-arms it. Existing records keep their state, so a session already past
   *  the old threshold is swept on the next tick. */
  configure(options: { idleMinutes?: number }): void {
    if (options.idleMinutes === undefined) return;
    this.idleMs = normalizeIdleMinutes(options.idleMinutes);
    if (this.disabled) {
      this.stop();
      return;
    }
    if (!this.sweepTimer && !this.closed) this.start();
  }

  get disabled(): boolean {
    return this.idleMs <= 0;
  }

  /** Start the periodic sweep. No-op when disabled or already running. */
  start(intervalMs = 60_000): void {
    if (this.closed || this.disabled || this.sweepTimer) return;
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, interval);
    // Never keep a process alive solely for the hibernation sweep.
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the sweep and cancel pending per-session timers. */
  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private ensure(sessionId: string): HibernationRecord {
    let record = this.records.get(sessionId);
    if (!record) {
      record = { sessionId, state: "active", lastActivityAt: this.now(), hibernations: 0, lastReleasedEntries: 0, lastReleasedBytes: 0 };
      this.records.set(sessionId, record);
    }
    return record;
  }

  /** Register (or replace) the derived caches one session owns. */
  setOwners(sessionId: string, owners: CacheOwner[]): void {
    this.owners.set(sessionId, owners);
  }

  /** Register the guards that protect one session's active work. */
  setGuards(sessionId: string, guards: HibernationGuard): void {
    this.guards.set(sessionId, guards);
  }

  /** Drop a session entirely (deleted/archived). */
  forget(sessionId: string): void {
    this.clearTimer(sessionId);
    this.records.delete(sessionId);
    this.owners.delete(sessionId);
    this.guards.delete(sessionId);
  }

  /** The agent produced work: the session is busy and must not hibernate. */
  markActive(sessionId: string): HibernationRecord {
    const record = this.ensure(sessionId);
    record.lastActivityAt = this.now();
    record.idleSince = undefined;
    this.clearTimer(sessionId);
    if (record.state !== "active") record.state = "active";
    return record;
  }

  /** The agent finished its turn and the session now waits on the user. */
  markIdle(sessionId: string): HibernationRecord {
    const record = this.ensure(sessionId);
    record.lastActivityAt = this.now();
    if (record.state === "idle") return record;
    record.state = "idle";
    record.idleSince = this.now();
    this.armTimer(sessionId);
    return record;
  }

  private armTimer(sessionId: string): void {
    if (this.disabled) return;
    this.clearTimer(sessionId);
    const timer = setTimeout(() => { void this.sweepSession(sessionId, "idle-timeout"); }, this.idleMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) { clearTimeout(timer); this.timers.delete(sessionId); }
  }

  private blockedReason(sessionId: string): string | undefined {
    const guard = this.guards.get(sessionId);
    if (!guard) return undefined;
    try {
      if (guard.running?.()) return "active-work";
      if (guard.pendingInput?.()) return "pending-input";
      if (guard.scheduledWake?.()) return "scheduled-wake";
    } catch {
      // A throwing guard must never crash the sweep; treat it as busy.
      return "guard-error";
    }
    return undefined;
  }

  /** True when the session may be hibernated right now. */
  canHibernate(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false;
    if (record.state === "hibernated") return false;
    return this.blockedReason(sessionId) === undefined;
  }

  /**
   * Release one session's derived caches. Returns what was released; a session
   * that is busy, unknown, already hibernated, or disabled is skipped.
   */
  hibernateSession(sessionId: string, options: HibernateOptions = {}): HibernationRecord {
    const record = this.ensure(sessionId);
    if (this.disabled && !options.force) return record;
    if (record.state === "hibernated" && !options.force) return record;
    const blocked = this.blockedReason(sessionId);
    if (blocked && !options.force) return record;

    this.clearTimer(sessionId);
    const owners = this.owners.get(sessionId) ?? [];
    let entries = 0;
    let bytes = 0;
    for (const owner of owners) {
      try {
        entries += owner.size();
        bytes += owner.bytes?.() ?? 0;
        owner.clear();
      } catch (err) {
        // A partial release is fine: state that was already released stays gone.
        record.lastError = `release failed for ${owner.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    record.state = "hibernated";
    record.hibernatedAt = this.now();
    record.idleSince = undefined;
    record.hibernations += 1;
    record.lastReleasedEntries = entries;
    record.lastReleasedBytes = bytes;
    this.hooks.onHibernation?.(record, { entries, bytes });
    return record;
  }

  /** Wake a hibernated session. Rebuild is implicit (lazy), so this is cheap. */
  wake(sessionId: string, reason = "user-input"): HibernationRecord {
    const record = this.ensure(sessionId);
    this.clearTimer(sessionId);
    record.lastActivityAt = this.now();
    record.idleSince = undefined;
    if (record.state === "hibernated") record.state = "active";
    record.wokeAt = this.now();
    this.hooks.onWake?.(record);
    return record;
  }

  getRecord(sessionId: string): HibernationRecord | undefined {
    return this.records.get(sessionId);
  }

  getState(sessionId: string): HibernationState {
    return this.records.get(sessionId)?.state ?? "active";
  }

  listRecords(): HibernationRecord[] {
    return [...this.records.values()];
  }

  /** Milliseconds until the session would hibernate; undefined when not idle. */
  msUntilHibernation(sessionId: string): number | undefined {
    const record = this.records.get(sessionId);
    if (!record || record.state !== "idle" || record.idleSince === undefined) return undefined;
    return Math.max(0, record.idleSince + this.idleMs - this.now());
  }

  private async sweepSession(sessionId: string, reason: string): Promise<{ slept: boolean; reason: string }> {
    const record = this.records.get(sessionId);
    if (!record) return { slept: false, reason: "unknown" };
    if (this.disabled) return { slept: false, reason: "disabled" };
    const blocked = this.blockedReason(sessionId);
    if (blocked) return { slept: false, reason: blocked };
    if (record.state !== "idle" || record.idleSince === undefined) return { slept: false, reason: "not-idle" };
    if (this.now() - record.idleSince < this.idleMs) return { slept: false, reason: "under-threshold" };
    const after = this.hibernateSession(sessionId, { immediate: true, force: true });
    if (after.state === "hibernated") return { slept: true, reason };
    return { slept: false, reason: after.lastError ? "release-failed" : "not-idle" };
  }

  /**
   * One sweep: hibernate every idle session past the threshold, record a single
   * before/after pair, then purge the allocator heap once. The purge is a hint,
   * so a reader that cannot observe a change is reported as flat, never as a
   * saving.
   */
  async sweep(): Promise<HibernationSweepResult> {
    this.sweeps += 1;
    const result: HibernationSweepResult = {
      sweeps: this.sweeps,
      hibernated: 0,
      entriesReleased: 0,
      bytesReleased: 0,
      skipped: [],
      purgedHeap: false,
    };
    if (this.disabled) return result;

    const beforeBytes = this.readServerBytes();
    for (const record of [...this.records.values()]) {
      const outcome = await this.sweepSession(record.sessionId, "sweep");
      if (outcome.slept) {
        const after = this.records.get(record.sessionId);
        result.hibernated += 1;
        result.entriesReleased += after?.lastReleasedEntries ?? 0;
        result.bytesReleased += after?.lastReleasedBytes ?? 0;
      } else {
        result.skipped.push({ sessionId: record.sessionId, reason: outcome.reason });
      }
    }
    const afterBytes = this.readServerBytes();
    result.beforeBytes = beforeBytes;
    result.afterBytes = afterBytes;
    result.rssChangeBytes = afterBytes - beforeBytes;
    result.purgedHeap = true;
    this.purgeHeap();
    if (result.hibernated > 0) {
      this.lastSweep = {
        at: new Date(this.now()).toISOString(),
        hibernated: result.hibernated,
        entriesReleased: result.entriesReleased,
        bytesReleased: result.bytesReleased,
        beforeBytes,
        afterBytes,
        rssChangeBytes: result.rssChangeBytes,
        purgedHeap: true,
      };
    }
    return result;
  }

  lastSweep?: HibernationStats["lastSweep"];

  /** Server-process reading used for the sweep's before/after pair. */
  private readServerBytes(): number {
    try {
      return collectMemoryProfile().server.rssBytes;
    } catch {
      return 0;
    }
  }

  /** Counters for the J6 `debug:memory` surface. */
  stats(): HibernationStats {
    const records = [...this.records.values()];
    return {
      idleMinutes: this.idleMs / 60_000,
      idleThresholdMs: this.idleMs,
      disabled: this.disabled,
      sessions: records.length,
      hibernated: records.filter((r) => r.state === "hibernated").length,
      hibernations: records.reduce((a, r) => a + r.hibernations, 0),
      entriesReleased: records.reduce((a, r) => a + r.lastReleasedEntries, 0),
      bytesReleased: records.reduce((a, r) => a + r.lastReleasedBytes, 0),
      ...(this.lastSweep ? { lastSweep: this.lastSweep } : {}),
    };
  }

  /** Test/teardown helper: drop every record, owner, guard and timer. */
  reset(): void {
    this.stop();
    this.records.clear();
    this.owners.clear();
    this.guards.clear();
    this.timers.clear();
    this.sweeps = 0;
    this.lastSweep = undefined;
  }

  /** Release timers; the sweep stops but records stay (used on shutdown). */
  close(): void {
    this.closed = true;
    this.stop();
  }
}

/** Shared manager used by the server; wired with real cache owners in src/index.ts. */
export const sessionHibernation = new HibernationManager();

/**
 * Re-export the J6 memory surface so a caller wiring the debug route needs one
 * import. `retainedCacheBytes()` is what makes the daemon's own bounded caches
 * observable to a bench.
 */
export { retainedCacheBytes, resetMemoryProfile };
