import { CancelledError } from "./runControl.js";

/** One active run owns the shared desktop/browser/runtime for its full lifetime. */
export class ExecutionQueue {
  private active: string | null = null;
  private waiting: Array<{ id: string; start: () => void; cancel: () => void }> = [];
  private ids = new Set<string>();
  private stopped = false;

  has(id: string): boolean { return this.ids.has(id); }
  snapshot(): { active: string | null; queued: string[] } {
    return { active: this.active, queued: this.waiting.map((job) => job.id) };
  }
  enqueue<T>(id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
        this.active = id;
        signal?.removeEventListener("abort", cancel);
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw new CancelledError();
          return work();
        }).then(resolve, reject).finally(() => {
          this.active = null;
          this.ids.delete(id);
          this.pump();
        });
      };
      this.waiting.push({ id, start, cancel });
      signal?.addEventListener("abort", cancel, { once: true });
      this.pump();
    });
  }
  stop(): void { this.stopped = true; for (const job of [...this.waiting]) job.cancel(); }
  private pump(): void {
    if (!this.active && !this.stopped) this.waiting.shift()?.start();
  }
}
export const executionQueue = new ExecutionQueue();
