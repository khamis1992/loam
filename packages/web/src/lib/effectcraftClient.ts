/**
 * Host-side registry for the hidden "Loam Effects" engine (fc-09 integration
 * point).
 *
 * The Effects panel owns its own iframe bridge (`packages/web/src/lib/effectcraft.ts`).
 * Agent tools and the round-trip planner need a stable, panel-agnostic way to
 * reach whichever engine instance is currently mounted, so the panel registers
 * a small target object here on mount and unregisters on unmount. This mirrors
 * `@/lib/filmcraftClient` for the video engine.
 *
 * Loam ships one product with two engines: Loam Video owns the timeline and
 * Loam Effects owns transitions / effects / text animation. Both may be mounted
 * at once (the panel swaps between them for "Open in effects"), so the registry
 * is per-engine rather than a single global.
 */

import type { EffectcraftBridge } from './effectcraft';

/** The effects surface a caller may drive. */
export interface LoamEffectsClientTarget {
  taskId: string;
  /** Live bridge once the engine API is ready; null while loading. */
  bridge: EffectcraftBridge | null;
  hasApi: boolean;
  /** The `.ecproj` the engine currently holds, when it reports one. */
  projectPath: string | null;
  /** Reopen a stored project in the engine. */
  openProject: (path: string) => Promise<unknown>;
}

let activeTarget: LoamEffectsClientTarget | null = null;
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

/** Register (or clear) the active effects target. Called by the mounted panel. */
export function setLoamEffectsTarget(target: LoamEffectsClientTarget | null): void {
  activeTarget = target;
  notify();
}

/** The currently open effects target, or null when no panel is mounted. */
export function getLoamEffectsTarget(): LoamEffectsClientTarget | null {
  return activeTarget;
}

/** Subscribe to target changes (mount/unmount). Returns an unsubscribe fn. */
export function subscribeLoamEffectsTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
