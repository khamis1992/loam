/**
 * Local-only memory profile (J6): per-process RSS plus every bounded cache
 * counter registered through `src/memory/stats.js`.
 *
 * Adapted from jcode (MIT) src/tui/memory_profile.rs — the same discipline:
 * memory changes are only reviewable when the numbers are collected by one
 * explicit surface instead of ad-hoc instrumentation. jcode exposes them as
 * TUI `:debug memory`; Loam exposes them here over loopback HTTP + desktop IPC.
 *
 * This module performs NO network I/O of its own. The HTTP route lives on the
 * existing loopback server behind the same install token as every other
 * `/api/*` route, and the desktop IPC handler is reachable only from the
 * privileged renderer origin. Nothing is ever sent to a remote host, and the
 * desktop handler deliberately strips every field but the RSS numbers.
 */
import os from "node:os";
import { collectCacheStats, cacheTotals, type CacheStats } from "./stats.js";

export interface ProcessMemory {
  pid: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface MemoryProfile {
  at: string;
  uptimeSeconds: number;
  platform: string;
  arch: string;
  /** This process (the one serving the route): the Loam server/Node process. */
  server: ProcessMemory;
  /** Node-side main-process counters the server can observe directly. */
  main: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  /** Renderer (Electron renderer / web tab) counters, when reported by the
   *  desktop main process. Null in a plain Node run (no Electron). */
  renderer: {
    rssBytes: number;
    heapUsedBytes: number;
    count: number;
  } | null;
  system: {
    totalBytes: number;
    freeBytes: number;
  };
  caches: CacheStats[];
  totals: { caches: number; entries: number; bytes: number };
}

/** Live renderer RSS samples reported by the desktop main process. */
interface RendererSample {
  pid: number;
  rssBytes: number;
  heapUsedBytes: number;
}

let rendererSamples: RendererSample[] = [];
let bootedAt = Date.now();

/** Record the RSS of one renderer/webContents process (desktop main process). */
export function reportRendererMemory(sample: RendererSample): void {
  if (!sample || !Number.isFinite(sample.pid)) return;
  const rss = Number(sample.rssBytes);
  if (!Number.isFinite(rss) || rss < 0) return;
  rendererSamples = rendererSamples.filter((s) => s.pid !== sample.pid);
  rendererSamples.push({
    pid: sample.pid,
    rssBytes: Math.round(rss),
    heapUsedBytes: Number.isFinite(sample.heapUsedBytes) ? Math.round(sample.heapUsedBytes) : 0,
  });
  // Never keep more windows than exist in a real desktop session.
  if (rendererSamples.length > 16) rendererSamples = rendererSamples.slice(-16);
}

/** Drop a renderer sample (window closed). */
export function forgetRendererMemory(pid: number): void {
  rendererSamples = rendererSamples.filter((s) => s.pid !== pid);
}

/** Test/teardown helper. */
export function resetMemoryProfile(): void {
  rendererSamples = [];
  bootedAt = Date.now();
}

function snapshot(): ProcessMemory {
  const m = process.memoryUsage();
  return {
    pid: process.pid,
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers,
  };
}

/** Collect the local memory profile. Safe to call on every request. */
export function collectMemoryProfile(): MemoryProfile {
  const server = snapshot();
  const caches = collectCacheStats();
  const total = os.totalmem();
  const free = os.freemem();
  return {
    at: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    platform: process.platform,
    arch: process.arch,
    server,
    main: {
      rssBytes: server.rssBytes,
      heapUsedBytes: server.heapUsedBytes,
      heapTotalBytes: server.heapTotalBytes,
      externalBytes: server.externalBytes,
    },
    renderer:
      rendererSamples.length === 0
        ? null
        : {
            rssBytes: rendererSamples.reduce((a, s) => a + s.rssBytes, 0),
            heapUsedBytes: rendererSamples.reduce((a, s) => a + s.heapUsedBytes, 0),
            count: rendererSamples.length,
          },
    system: { totalBytes: total, freeBytes: free },
    caches,
    totals: cacheTotals(caches),
  };
}

/** Total bytes this process currently retains across every bounded cache. */
export function retainedCacheBytes(stats: CacheStats[] = collectCacheStats()): number {
  return cacheTotals(stats).bytes;
}

/** Human-readable MB helper for logs and the debug surface. */
export function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}
