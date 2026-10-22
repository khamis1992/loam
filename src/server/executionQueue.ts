import { CancelledError } from "./runControl.js";

/**
 * Lane-based execution queue: runs declare resource LOCKS (e.g. "browser",
 * "preview") they need; runs sharing a lock serialize, lock-free runs (own-device
 * work, office/data tasks...) execute in PARALLEL up to the concurrency cap.
 * The legacy single-lock behavior is preserved for callers that pass no locks
 * (they all share the "exclusive" lock).
 */
export class ExecutionQueue {
  private readonly locks = new Map<string, string>(); // lock -> owning job id
  private readonly running = new Set<string>();
  private waiting: Array<{ id: string; locks: string[]; start: () => void; cancel: () => void }> = [];
  private ids = new Set<string>();
  private stopped = false;

  constructor(private readonly maxConcurrent = 4) {}

  has(id: string): boolean { return this.ids.has(id); }

  snapshot(): { active: string | null; actives: string[]; queued: string[]; lanes: Array<{ lock: string; owner: string | null }> } {
    return {
      active: [...this.running][0] ?? null,
      actives: [...this.running],
      queued: this.waiting.map((job) => job.id),
      lanes: [...this.locks.entries()].map(([lock, owner]) => ({ lock, owner })),
    };
  }

  enqueue<T>(id: string, work: () => Promise<T>, signal?: AbortSignal, locks: string[] = ["exclusive"]): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("execution queue is shutting down"));
    if (this.ids.has(id)) return Promise.reject(new Error("task already queued or running"));
    if (signal?.aborted) return Promise.reject(new CancelledError());
    this.ids.add(id);
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => {
        const index = this.waiting.findIndex((job) => job.id === id);
        if (index < 0) return; // active jobs retain ownership until work actually exits
        this.waiting.splice(index, 1);
        this.ids.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(new CancelledError());
      };
      const start = (): void => {
        this.running.add(id);
        for (const lock of locks) this.locks.set(lock, id);
        signal?.removeEventListener("abort", cancel);
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw new CancelledError();
          return work();
        }).then(resolve, reject).finally(() => {
          this.running.delete(id);
          for (const lock of locks) if (this.locks.get(lock) === id) this.locks.delete(lock);
          this.ids.delete(id);
          this.pump();
        });
      };
      this.waiting.push({ id, locks, start, cancel });
      signal?.addEventListener("abort", cancel, { once: true });
      this.pump();
    });
  }

  stop(): void { this.stopped = true; for (const job of [...this.waiting]) job.cancel(); }

  private pump(): void {
    while (!this.stopped && this.running.size < this.maxConcurrent) {
      const index = this.waiting.findIndex((job) => job.locks.every((lock) => !this.locks.has(lock)));
      if (index < 0) return;
      const [job] = this.waiting.splice(index, 1);
      if (!job) return;
      job.start();
    }
  }
}
export const executionQueue = new ExecutionQueue(4);
