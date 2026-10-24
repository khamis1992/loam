/**
 * Shared, bounded LRU caches for Loam's in-memory hot paths.
 *
 * Adapted from jcode (MIT) src/memory/lru.rs — the bounded-cache semantics
 * (insert, touch-on-read, evict least-recently-used) match jcode's markdown
 * highlight cache and mermaid render cache. See docs/MEMORY_BUDGET.md.
 *
 * Every cache here reports its `size` and `capacity` through
 * `collectCacheStats()`, which is the single source of truth for the local
 * `debug:memory` surface. Nothing in this module touches the network.
 */
import type { CacheStats } from "./stats.js";

export interface LruOptions<V = unknown> {
  /** Maximum number of live entries. Values <= 0 disable the cap (entry-count cap only). */
  capacity: number;
  /** Logical name reported by `collectCacheStats`. */
  name: string;
  /** Optional byte ceiling; entries are evicted oldest-first while over it. */
  maxBytes?: number;
  /** Estimate the retained bytes of one entry (defaults to 0 = byte cap unused). */
  sizeOf?: (value: V) => number;
}

/** Approximate retained bytes for a string entry (UTF-16 code units). */
export function byteSizeOfString(value: string): number {
  return value.length * 2;
}

/** Approximate retained bytes for a Buffer/Uint8Array entry. */
export function byteSizeOfBytes(value: Uint8Array): number {
  return value.byteLength;
}

/**
 * A bounded least-recently-used map. Insertion order is eviction order; reading
 * a key (or re-inserting it) moves it to the newest slot, so the oldest
 * untouched entry is always the one dropped.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private bytes = 0;

  constructor(private readonly options: LruOptions<V>) {}

  get capacity(): number {
    return this.options.capacity;
  }

  get name(): string {
    return this.options.name;
  }

  get size(): number {
    return this.map.size;
  }

  /** Current retained bytes as estimated by `sizeOf` (0 when no estimator is set). */
  get retainedBytes(): number {
    return this.bytes;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Read a key and mark it most-recently-used. */
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) return undefined;
    // Re-insert to move the key to the newest position (Map preserves order).
    this.map.delete(key);
    this.map.set(key, value as V);
    return value;
  }

  /** Insert or refresh a key.
   *
   *  Returns `false` when `value` alone is larger than `maxBytes`: no set of
   *  entries can ever satisfy the ceiling while that value is present, so
   *  retaining it would report a cache that is permanently over budget (the
   *  old implementation evicted everything else and then stopped, leaving
   *  `bytes > maxBytes`). Dropping it keeps the reported `bytes <= maxBytes`
   *  invariant the `debug:memory` surface documents.
   */
  set(key: string, value: V): boolean {
    const sizeOf = this.options.sizeOf;
    if (sizeOf && this.options.maxBytes && sizeOf(value) > this.options.maxBytes) {
      // Drop any prior copy too, so a shrunken ceiling cannot leave stale bytes.
      this.delete(key);
      return false;
    }
    if (sizeOf) {
      const previous = this.map.get(key);
      if (previous !== undefined) this.bytes -= sizeOf(previous);
      this.bytes += sizeOf(value);
    }
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.options.capacity > 0 && this.map.size >= this.options.capacity) {
      this.evictOne();
    }
    this.map.set(key, value);
    if (this.options.maxBytes && sizeOf) this.evictUntilBytesFit(key);
    return true;
  }

  delete(key: string): boolean {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) return false;
    if (this.options.sizeOf) this.bytes -= this.options.sizeOf(value as V);
    return this.map.delete(key);
  }

  /** Remove a key and return its value (undefined when absent). Unlike
   *  `delete`, this gives the caller the dropped entry so it can account for
   *  the bytes it released (J7 hibernation counters). */
  take(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) return undefined;
    if (this.options.sizeOf) this.bytes -= this.options.sizeOf(value as V);
    this.map.delete(key);
    return value as V;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  private evictOne(): void {
    const oldest = this.map.keys().next();
    if (oldest.done) return;
    const key = oldest.value;
    const value = this.map.get(key);
    if (this.options.sizeOf && value !== undefined) this.bytes -= this.options.sizeOf(value);
    this.map.delete(key);
  }

  /** Keep evicting until the retained estimate is within `maxBytes`.
   *  `protect` is the just-inserted key: it is never evicted, because a caller
   *  that asked for an entry expects it to be there. Callers must therefore
   *  reject an entry that cannot fit (see `set`), otherwise `bytes` would exceed
   *  the ceiling. */
  private evictUntilBytesFit(protect: string): void {
    const ceiling = this.options.maxBytes ?? 0;
    while (this.bytes > ceiling) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      if (oldest.value === protect) return;
      this.evictOne();
    }
  }

  stats(): CacheStats {
    return {
      name: this.options.name,
      size: this.map.size,
      capacity: this.options.capacity,
      bytes: this.bytes,
      maxBytes: this.options.maxBytes ?? 0,
    };
  }
}

/**
 * Wrap an unbounded `Map` so it behaves like an LRU with a hard cap without
 * changing call sites that expect `get`/`set`/`delete`/`has`/`size`.
 *
 * Reads and writes refresh recency; when the cap is exceeded the oldest entry
 * is dropped. This is the drop-in shape used for pre-existing module-level
 * caches that previously had no bound.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly name = "",
    /** Called with the dropped entry so a holder can release the resource it
     *  wrapped (close a browser context, kill a child process, ...). */
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get capacityLimit(): number {
    return this.capacity;
  }

  /** Counter row for the local `debug:memory` surface (no byte estimator). */
  stats(): CacheStats {
    return { name: this.name, size: this.map.size, capacity: this.capacity, bytes: 0, maxBytes: 0 };
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) return undefined;
    this.map.delete(key);
    this.map.set(key, value as V);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.capacity > 0 && this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        const evicted = this.map.get(oldest.value) as V;
        this.map.delete(oldest.value);
        try {
          this.onEvict?.(oldest.value, evicted);
        } catch {
          /* an eviction hook must never break the write that triggered it */
        }
      }
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Drop the oldest entry and run the eviction hook. Test helper. */
  evictOldest(): boolean {
    const oldest = this.map.keys().next();
    if (oldest.done) return false;
    const evicted = this.map.get(oldest.value) as V;
    this.map.delete(oldest.value);
    try {
      this.onEvict?.(oldest.value, evicted);
    } catch {
      /* see set() */
    }
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }
}
