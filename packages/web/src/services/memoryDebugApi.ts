/**
 * Local `debug:memory` client (J6).
 *
 * In the desktop shell the numbers come from the desktop main process over IPC
 * (it is the only process that can see the Node server child and every
 * renderer window). In a plain browser the same numbers are read from the
 * loopback HTTP route, which is already behind the app's local auth token.
 * Either way nothing leaves the machine.
 */
import { getApiBase, getApiHeaders } from './rpc';

export interface MemoryDebugSnapshot {
  at: string;
  mainRssMb: number;
  rendererRssMb: number;
  rendererCount: number;
  serverRssMb: number;
  serverPid: number | null;
  /**
   * J7: how many `app.getAppMetrics()` rows matched a renderer window, and their
   * pids. A zero `rendererRssMb` with `rendererMatched > 0` means the renderer
   * genuinely uses no measurable memory; `rendererMatched === 0` means no row
   * matched at all, which is a sampler problem rather than a saving.
   */
  rendererMatched?: number;
  rendererPids?: number[];
}

/** J7: the on-demand renderer re-sample `debugMemory.refresh` returns. */
export interface MemoryDebugRefresh {
  rendererRssMb: number;
  matched: number;
  pids: number[];
}

export interface MemoryDebugPayload extends Partial<MemoryDebugSnapshot> {
  server?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  } | null;
  renderer?: {
    rssBytes: number;
    heapUsedBytes: number;
    count: number;
  } | null;
  system?: { totalBytes: number; freeBytes: number };
  caches?: Array<{ name: string; size: number; capacity: number; bytes: number; maxBytes: number }>;
  totals?: { caches: number; entries: number; bytes: number };
}

function mb(bytes: number | undefined): number {
  if (!bytes || !Number.isFinite(bytes)) return 0;
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Desktop shell: ask the main process for its sampled RSS numbers. */
export async function getDesktopMemorySnapshot(): Promise<MemoryDebugSnapshot | null> {
  const apis = (typeof window !== 'undefined'
    ? (window as unknown as { __apis?: { debugMemory?: { snapshot?: () => Promise<MemoryDebugSnapshot> } } }).__apis
    : undefined);
  if (!apis?.debugMemory?.snapshot) return null;
  try {
    return (await apis.debugMemory.snapshot()) ?? null;
  } catch {
    return null;
  }
}

/**
 * J7: force the main process to re-derive the renderer total right now. The
 * regular sampler ticks every 15 s, which is far too coarse to bracket a
 * hibernate/wake, so a before/after measurement calls this on both sides.
 */
export async function refreshDesktopMemory(): Promise<MemoryDebugRefresh | null> {
  const apis = (typeof window !== 'undefined'
    ? (window as unknown as { __apis?: { debugMemory?: { refresh?: () => Promise<MemoryDebugRefresh> } } }).__apis
    : undefined);
  if (!apis?.debugMemory?.refresh) return null;
  try {
    return (await apis.debugMemory.refresh()) ?? null;
  } catch {
    return null;
  }
}

/** Loopback HTTP route: full profile including every bounded-cache counter. */
export async function fetchMemoryDebug(): Promise<MemoryDebugPayload | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/debug/memory`, { headers: await getApiHeaders(), cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as MemoryDebugPayload;
  } catch {
    return null;
  }
}

/** Best available view: desktop IPC first, loopback route as the fallback. */
export async function loadMemoryDebug(): Promise<MemoryDebugPayload> {
  const desktop = await getDesktopMemorySnapshot();
  const route = await fetchMemoryDebug();
  return {
    at: desktop?.at ?? route?.at ?? new Date().toISOString(),
    mainRssMb: desktop?.mainRssMb ?? mb(route?.server?.rssBytes),
    rendererRssMb: desktop?.rendererRssMb ?? mb(route?.renderer?.rssBytes),
    rendererCount: desktop?.rendererCount ?? route?.renderer?.count ?? 0,
    serverRssMb: desktop?.serverRssMb ?? mb(route?.server?.rssBytes),
    serverPid: desktop?.serverPid ?? null,
    server: route?.server ?? null,
    system: route?.system ?? undefined,
    caches: route?.caches ?? [],
    totals: route?.totals ?? undefined,
  };
}
