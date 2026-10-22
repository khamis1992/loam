/** Unbounded live event queue shared by both subagent providers.
 *
 *  Consumers iterate `events` as items are produced. The queue closes when the
 *  run finishes (or fails), which ends the async iteration cleanly. This avoids
 *  the race of a snapshot-array iterator that exits before later events land.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.failure = err;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    while (this.waiters.length > 0) this.waiters.shift()!();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    const iterator: AsyncIterator<T> = {
      next: async (): Promise<IteratorResult<T>> => {
        while (index >= this.items.length) {
          if (this.failure) {
            const err = this.failure;
            this.failure = null;
            throw err;
          }
          if (this.closed) return { done: true as const, value: undefined };
          await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        return { done: false as const, value: this.items[index++]! };
      },
      return: async (): Promise<IteratorResult<T>> => {
        // A consumer that stops early must not tear down the producer; simply
        // end this iterator. The queue stays open for other consumers/result().
        return { done: true as const, value: undefined };
      },
    };
    return iterator;
  }
}
