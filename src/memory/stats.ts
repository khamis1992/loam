/**
 * Cache counters for the local `debug:memory` surface (J6).
 *
 * Adapted from jcode (MIT) src/tui/memory_profile.rs — the idea is the same:
 * memory changes are only reviewable when every bounded cache exposes a
 * counter. Each capped cache calls `registerCache`/`unregisterCache` with a
 * `CacheStats` snapshot function; `collectCacheStats()` returns them all so
 * the local HTTP/IPC debug surface can report per-cache occupancy without
 * touching the network.
 *
 * Registering a cache never fails: a duplicate name is replaced, so a module
 * that re-registers on hot reload cannot silently accumulate stale counters.
 */

export interface CacheStats {
  /** Logical name, e.g. "skills-desc", "slide-preview". */
  name: string;
  /** Live entries right now. */
  size: number;
  /** Configured hard cap (0 = uncapped). */
  capacity: number;
  /** Estimated retained bytes (0 when the cache has no byte estimator). */
  bytes: number;
}

type Snapshot = () => CacheStats;

const caches = new Map<string, Snapshot>();

/** Register (or replace) the stats snapshot for one bounded cache. */
export function registerCacheStats(name: string, snapshot: Snapshot): void {
  if (!name) return;
  caches.set(name, snapshot);
}

/** Remove a cache from the registry (used on teardown / tests). */
export function unregisterCacheStats(name: string): void {
  caches.delete(name);
}

export function cacheNames(): string[] {
  return [...caches.keys()].sort();
}

/** Snapshot every registered cache. Snapshots that throw are skipped rather
 *  than failing the whole debug surface. */
export function collectCacheStats(): CacheStats[] {
  const out: CacheStats[] = [];
  for (const [name, snapshot] of caches) {
    try {
      out.push(snapshot());
    } catch {
      out.push({ name, size: 0, capacity: 0, bytes: 0 });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Total live entries and estimated retained bytes across every capped cache. */
export function cacheTotals(stats: CacheStats[] = collectCacheStats()): { entries: number; bytes: number; caches: number } {
  return {
    caches: stats.length,
    entries: stats.reduce((a, s) => a + s.size, 0),
    bytes: stats.reduce((a, s) => a + s.bytes, 0),
  };
}

/** Test/teardown helper. */
export function resetCacheStatsRegistry(): void {
  caches.clear();
}
