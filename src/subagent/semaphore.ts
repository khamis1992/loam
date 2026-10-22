/** Counting semaphore used to bound concurrent child subagents.
 *  The limit may be tightened or relaxed at runtime (configuration changes);
 *  waiters woken by a raised limit never exceed the new bound. */
export class Semaphore {
  private active = 0;
  private limit: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
  }

  /** Configured upper bound. */
  get max(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  /** Change the bound, waking waiters when the limit is raised. */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
    this.drain();
  }

  /** Acquires a slot, resolving with a release function. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    // The slot is reserved by drain() the moment a waiter is woken, so several
    // rapid releases cannot wake more waiters than there are free slots.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      this.active += 1;
      this.waiters.shift()!();
    }
  }
}
