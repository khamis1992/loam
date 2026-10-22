/**
 * Host-side client hook for the "Loam Video" studio (fc-02 integration point).
 *
 * The Loam Video panel owns the FilmCraft iframe bridge
 * (`packages/web/src/lib/filmcraft.ts`). Agent tools need a stable, panel-agnostic
 * way to reach the currently open studio so they can inspect the timeline and
 * drive edits. Rather than reaching into React state, the mounted panel registers
 * a small target object here; agent code calls {@link getLoamVideoTarget}.
 *
 * fc-02 owns the agent tool that consumes this hook. Until it lands, this module
 * is the documented seam: the panel registers on mount and unregisters on
 * unmount, and the tool reads `bridge` / `importSource`.
 */

import type { FilmcraftBridge } from './filmcraft';

/** The studio surface an agent tool may drive. */
export interface LoamVideoClientTarget {
  taskId: string;
  /** Live bridge once the editor API is ready; null while loading. */
  bridge: FilmcraftBridge | null;
  hasApi: boolean;
  /** Import a task-workspace media path into the open studio. */
  importSource: (path: string) => Promise<unknown>;
}

let activeTarget: LoamVideoClientTarget | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a listener failure must not break registration */
    }
  }
}

/** Register (or clear) the active studio target. Called by the mounted panel. */
export function setLoamVideoTarget(target: LoamVideoClientTarget | null): void {
  activeTarget = target;
  notify();
}

/** The currently open studio target, or null when no panel is mounted. */
export function getLoamVideoTarget(): LoamVideoClientTarget | null {
  return activeTarget;
}

/** Subscribe to target changes (mount/unmount). Returns an unsubscribe fn. */
export function subscribeLoamVideoTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
