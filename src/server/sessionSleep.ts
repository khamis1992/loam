/**
 * Session sleep/wake lifecycle (D19): a session that the agent has finished
 * with and that is now only waiting on the user is not doing any work. After
 * N minutes of that idle state it transitions to `sleeping`, releasing heavy
 * resources (browser session, pty terminals) AFTER the session state has been
 * persisted. The next user message wakes it and restores what was released.
 *
 * Design constraints that keep this testable and safe:
 * - The clock is injected (`now`), so the deterministic gate can drive the idle
 *   transition with fake timers instead of waiting 30 real minutes.
 * - Release/restore hooks are injected (`hooks`), so tests assert the exact
 *   resource lifecycle without spawning a real browser or shell.
 * - Persist-before-release ordering is enforced by the manager itself: the
 *   persisted snapshot is written first, and only then are resources released.
 *   A failure while releasing never loses state (it is already persisted).
 */

/** Sleep state of a session. `idle` = waiting on the user, not yet reclaimed. */
export type SessionSleepState = "active" | "idle" | "sleeping" | "awake";

/** Resources a sleeping session had to give up, so a wake can restore them. */
export interface SleepSnapshot {
  /** Session state was flushed to storage at this instant. */
  persistedAt: string;
  /** Browser session id that was closed (empty when none was open). */
  browserSession?: string;
  /** Terminal ids that were killed (empty when none were open). */
  ptySessions: string[];
}

export interface SleepHooks {
  /** Persist session state BEFORE any resource is released. Must not throw. */
  persist(): Promise<void> | void;
  /** Release heavy resources. Called after persist succeeds. */
  release(): Promise<void> | void;
  /** Restore what `release` gave up. Called on wake. */
  restore(snapshot: SleepSnapshot): Promise<void> | void;
}

export interface SleepRecord {
  sessionId: string;
  state: SessionSleepState;
  /** When the session last had agent activity. */
  lastActivityAt: number;
  /** When the session entered `idle` (waiting on the user). */
  idleSince?: number;
  /** When the session was put to sleep. */
  sleptAt?: number;
  /** When the session was last woken. */
  wokeAt?: number;
  /** How many times this session has slept. */
  sleeps: number;
  snapshot?: SleepSnapshot;
  /** Last release failure, kept so the UI can surface it instead of hiding it. */
  lastError?: string;
}

export interface SleepManagerOptions {
  /** Idle minutes before an idle session is put to sleep (default 30). */
  idleMinutes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  hooks?: Partial<Record<string, SleepHooks>>;
  /** Called whenever a session changes state, so callers can persist/log. */
  onStateChange?: (record: SleepRecord, reason: string) => void;
}

const DEFAULT_IDLE_MINUTES = 30;

export class SessionSleepManager {
  private readonly records = new Map<string, SleepRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly hooks: Partial<Record<string, SleepHooks>>;
  private readonly onStateChange?: (record: SleepRecord, reason: string) => void;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: SleepManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const minutes = options.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.idleMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES) * 60_000;
    this.hooks = options.hooks ?? {};
    this.onStateChange = options.onStateChange;
  }

  /** Start the periodic sweep. No-op when already running. */
  start(intervalMs = 60_000): void {
    if (this.closed || this.sweepTimer) return;
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, interval);
    // Never keep a process alive solely for the sleep sweep.
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the sweep and cancel pending per-session timers. */
  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Idle after which a session is put to sleep. */
  get idleThresholdMs(): number {
    return this.idleMs;
  }

  private ensure(sessionId: string): SleepRecord {
    let record = this.records.get(sessionId);
    if (!record) {
      record = { sessionId, state: "active", lastActivityAt: this.now(), sleeps: 0 };
      this.records.set(sessionId, record);
    }
    return record;
  }

  private setState(record: SleepRecord, state: SessionSleepState, reason: string): void {
    record.state = state;
    this.onStateChange?.(record, reason);
  }

  /**
   * Register (or replace) the resource hooks for one session. Called when a
   * run starts, so the browser/pty ids this session owns are known.
   */
  setHooks(sessionId: string, hooks: SleepHooks): void {
    this.hooks[sessionId] = hooks;
  }

  clearHooks(sessionId: string): void {
    delete this.hooks[sessionId];
  }

  /** The agent produced activity: the session is busy again and must not sleep. */
  async markActive(sessionId: string): Promise<SleepRecord> {
    const record = this.ensure(sessionId);
    record.lastActivityAt = this.now();
    record.idleSince = undefined;
    this.clearTimer(sessionId);
    if (record.state === "sleeping") {
      // Activity on a sleeping session means the user came back: wake it.
      return this.wake(sessionId, "activity");
    }
    if (record.state !== "active") this.setState(record, "active", "agent activity");
    return record;
  }

  /**
   * The agent finished its turn and the session is now waiting on the user.
   * This is the only state that can later become `sleeping`.
   */
  markIdle(sessionId: string): SleepRecord {
    const record = this.ensure(sessionId);
    record.lastActivityAt = this.now();
    if (record.state === "sleeping") return record; // already reclaimed; keep the snapshot
    if (record.state === "idle") return record;
    record.idleSince = this.now();
    this.setState(record, "idle", "waiting on user");
    this.armTimer(sessionId);
    return record;
  }

  private armTimer(sessionId: string): void {
    this.clearTimer(sessionId);
    const timer = setTimeout(() => { void this.sleep(sessionId, "idle-timeout"); }, this.idleMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) { clearTimeout(timer); this.timers.delete(sessionId); }
  }

  /**
   * Put an idle session to sleep: persist first, then release resources.
   * A sleeping session cannot sleep again (idempotent).
   */
  async sleep(sessionId: string, reason = "idle-timeout"): Promise<SleepRecord> {
    const record = this.ensure(sessionId);
    if (record.state === "sleeping") return record;
    this.clearTimer(sessionId);
    record.lastActivityAt = this.now();

    const hooks = this.hooks[sessionId];
    const snapshot: SleepSnapshot = { persistedAt: new Date(this.now()).toISOString(), ptySessions: [] };
    try {
      await hooks?.persist?.();
    } catch (err) {
      // Never lose state: a failed persist keeps the session alive so nothing is released.
      record.lastError = `persist failed: ${err instanceof Error ? err.message : String(err)}`;
      this.setState(record, "idle", "persist-failed");
      this.armTimer(sessionId);
      return record;
    }
    if (hooks?.release) {
      try {
        await hooks.release();
      } catch (err) {
        record.lastError = `release failed: ${err instanceof Error ? err.message : String(err)}`;
        // State is already persisted; the session still sleeps, with the error surfaced.
      }
    }
    record.sleptAt = this.now();
    record.sleeps += 1;
    record.snapshot = snapshot;
    this.setState(record, "sleeping", reason);
    return record;
  }

  /** Wake a sleeping session and restore what was released. */
  async wake(sessionId: string, reason = "user-message"): Promise<SleepRecord> {
    const record = this.ensure(sessionId);
    this.clearTimer(sessionId);
    record.lastActivityAt = this.now();
    if (record.state !== "sleeping") {
      record.idleSince = undefined;
      this.setState(record, "active", reason);
      return record;
    }
    const hooks = this.hooks[sessionId];
    if (hooks?.restore) {
      try {
        await hooks.restore(record.snapshot ?? { persistedAt: new Date(this.now()).toISOString(), ptySessions: [] });
      } catch (err) {
        record.lastError = `restore failed: ${err instanceof Error ? err.message : String(err)}`;
        // The session still wakes: an unrestored browser is recreated on demand.
      }
    }
    record.wokeAt = this.now();
    record.snapshot = undefined;
    record.idleSince = undefined;
    this.setState(record, "awake", reason);
    return record;
  }

  /**
   * A new user message arrives: wake (if sleeping) and mark the session active.
   * This is the AC path "message -> awake with state restored".
   */
  async onUserMessage(sessionId: string): Promise<SleepRecord> {
    const wasSleeping = this.records.get(sessionId)?.state === "sleeping";
    const record = await this.wake(sessionId, "user-message");
    if (wasSleeping) {
      // wake() leaves the record in `awake`; the new work makes it active again.
      this.setState(record, "active", "user-message");
    }
    return record;
  }

  getRecord(sessionId: string): SleepRecord | undefined {
    return this.records.get(sessionId);
  }

  /** Current state, defaulting to `active` for an unknown session. */
  getState(sessionId: string): SessionSleepState {
    return this.records.get(sessionId)?.state ?? "active";
  }

  isSleeping(sessionId: string): boolean {
    return this.getState(sessionId) === "sleeping";
  }

  listRecords(): SleepRecord[] {
    return [...this.records.values()];
  }

  /** Milliseconds until the session would be put to sleep; undefined when not idle. */
  msUntilSleep(sessionId: string): number | undefined {
    const record = this.records.get(sessionId);
    if (!record || record.state !== "idle" || record.idleSince === undefined) return undefined;
    return Math.max(0, record.idleSince + this.idleMs - this.now());
  }

  /** Periodic sweep: put every idle session past the threshold to sleep. */
  async sweep(): Promise<Array<{ sessionId: string; slept: boolean; reason: string }>> {
    const out: Array<{ sessionId: string; slept: boolean; reason: string }> = [];
    for (const record of [...this.records.values()]) {
      if (record.state !== "idle" || record.idleSince === undefined) continue;
      if (this.now() - record.idleSince < this.idleMs) continue;
      const after = await this.sleep(record.sessionId, "sweep");
      out.push({
        sessionId: record.sessionId,
        slept: after.state === "sleeping",
        reason: after.state === "sleeping" ? "idle-timeout" : "persist-failed",
      });
    }
    return out;
  }

  /** Drop a session entirely (deleted/archived). */
  forget(sessionId: string): void {
    this.clearTimer(sessionId);
    this.records.delete(sessionId);
  }

  /** Test helper: clear every record and timer. */
  reset(): void {
    this.stop();
    this.records.clear();
  }

  /** Release timers; the sweep stops but records stay (used on shutdown). */
  close(): void {
    this.closed = true;
    this.stop();
  }
}

/** Shared manager used by the server; wired with real hooks in src/index.ts. */
export const sessionSleep = new SessionSleepManager();

export { DEFAULT_IDLE_MINUTES };
