/**
 * C2: durability modes for the orchestrator's saveCheckpoint hook
 * (index.ts today writes every checkpoint synchronously = "sync").
 *   sync  - write before the next step starts (today's behaviour, default)
 *   async - queue and write on the next macrotask; order preserved
 *   exit  - keep only the newest in memory; write on interrupt, end, error, abort
 * Same three names as LangGraph.js Durability (pregel/types.ts:35); own code.
 */
import type { DurabilityMode } from "../config.js";

export interface CheckpointSink<C> {
  save(cp: C): void;
  /** Must be called on interrupt, completion, error and abort. */
  flush(): void;
  pending(): number;
}

export function createCheckpointSink<C>(mode: DurabilityMode, write: (cp: C) => void): CheckpointSink<C> {
  if (mode === "sync") return { save: write, flush: () => {}, pending: () => 0 };
  if (mode === "exit") {
    let last: C | undefined;
    return {
      save: (cp) => {
        last = cp;
      },
      flush: () => {
        if (last !== undefined) write(last);
        last = undefined;
      },
      pending: () => (last === undefined ? 0 : 1),
    };
  }
  const queue: C[] = [];
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    while (queue.length) write(queue.shift() as C);
  };
  return {
    save: (cp) => {
      queue.push(cp);
      if (!scheduled) {
        scheduled = true;
        setImmediate(drain);
      }
    },
    flush: drain,
    pending: () => queue.length,
  };
}
