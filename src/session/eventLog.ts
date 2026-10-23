import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { LruCache } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

/** Current on-disk event-log format. Older generations are migrated up to this. */
export const CURRENT_FORMAT_VERSION = 1;

export interface SessionHeader {
  formatVersion: number;
  taskId: string;
  createdAt: string;
  cwd: string;
  /** Pointer to the active generation file, e.g. "events.jsonl" or "events.v1.jsonl". */
  logFile?: string;
}

export interface LogEvent {
  /** Contiguous, starting at 0. */
  seq: number;
  ts: number;
  type: string;
  data: unknown;
}

export interface Migration {
  from: number;
  to: number;
  migrateHeader: (h: SessionHeader) => SessionHeader;
  migrateEvent: (e: LogEvent) => LogEvent;
}

/** A compiled, contiguous migration chain (same shape as a single step). */
export type MigrationChain = Migration;

export interface Projection<S> {
  key: string;
  init: () => S;
  apply: (state: S, event: LogEvent) => S;
}

export class ContiguityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContiguityError";
  }
}

export class MigrationChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationChainError";
  }
}

export function defineMigration(migration: Migration): Migration {
  return migration;
}

/**
 * Validate a migration list into a single composed chain.
 * Rejects empty chains, non-adjacent steps (to !== from + 1), duplicate
 * source versions, and gaps between consecutive steps.
 */
export function compileMigrationChain(migrations: Migration[]): MigrationChain {
  if (migrations.length === 0) {
    throw new MigrationChainError("migration chain is empty");
  }
  const sorted = [...migrations].sort((a, b) => a.from - b.from);
  const seen = new Set<number>();
  let expectedFrom = sorted[0]!.from;
  for (const m of sorted) {
    if (m.to !== m.from + 1) {
      throw new MigrationChainError(`migration must advance exactly one version: v${m.from} -> v${m.to}`);
    }
    if (seen.has(m.from)) {
      throw new MigrationChainError(`duplicate migration for v${m.from}`);
    }
    seen.add(m.from);
    if (m.from !== expectedFrom) {
      throw new MigrationChainError(`migration chain gap: expected v${expectedFrom}, got v${m.from}`);
    }
    expectedFrom = m.to;
  }
  const from = sorted[0]!.from;
  const to = sorted[sorted.length - 1]!.to;
  return {
    from,
    to,
    migrateHeader: (h) => sorted.reduce((acc, m) => m.migrateHeader(acc), h),
    migrateEvent: (e) => sorted.reduce((acc, m) => m.migrateEvent(acc), e),
  };
}

interface ParsedLog {
  events: LogEvent[];
  /** Byte offset where a torn final line begins, or null when the file is clean. */
  tornOffset: number | null;
}

function isValidEvent(value: unknown): value is LogEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.seq === "number" && typeof v.ts === "number" && typeof v.type === "string";
}

/**
 * Parse JSONL content. Throws ContiguityError on a gap/duplicate seq or on a
 * corrupted line that is NOT the final line. A torn final line (crash mid-write)
 * is tolerated and reported via `tornOffset` without throwing.
 */
function parseLogContent(content: string): ParsedLog {
  const lines = content.split("\n");
  const events: LogEvent[] = [];
  let offset = 0;
  let tornOffset: number | null = null;

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      lastNonBlank = i;
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      offset += Buffer.byteLength(line, "utf8") + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lastNonBlank) {
        tornOffset = offset;
        break;
      }
      throw new ContiguityError(`invalid JSON at line ${i + 1}`);
    }
    if (!isValidEvent(parsed)) {
      if (i === lastNonBlank) {
        tornOffset = offset;
        break;
      }
      throw new ContiguityError(`invalid event at line ${i + 1}`);
    }
    events.push(parsed);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }

  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== i) {
      throw new ContiguityError(`seq contiguity violation: expected ${i}, got ${events[i]!.seq}`);
    }
  }

  return { events, tornOffset };
}

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

/** Stream events from the source generation into a new one, applying the chain per line. */
async function migrateStreaming(sourcePath: string, targetPath: string, chain: MigrationChain): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf8");
  } catch {
    content = "";
  }
  const { events } = parseLogContent(content);
  const handle = await fs.open(targetPath, "w");
  try {
    for (const event of events) {
      await handle.write(JSON.stringify(chain.migrateEvent(event)) + "\n");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const projectionRegistry = new Map<string, Projection<any>>();
/** Bounded incremental-fold cache (J6): one state per registered projection key.
 *  A projection state can be large (it mirrors the whole transcript), so the
 *  number of concurrently cached projections is capped. */
const projectionCache = new LruCache<{ lastSeq: number; state: unknown }>({ capacity: 64, name: "eventlog-projection" });
registerCacheStats("eventlog-projection", () => projectionCache.stats());

export function registerProjection<S>(projection: Projection<S>): void {
  projectionRegistry.set(projection.key, projection);
  projectionCache.delete(projection.key);
}

/**
 * Fold a registered projection over `events`, reusing a cached state keyed by the
 * last seq so appended events are folded incrementally instead of from scratch.
 */
export function getProjection<S>(key: string, events: LogEvent[]): S {
  const projection = projectionRegistry.get(key) as Projection<S> | undefined;
  if (!projection) {
    throw new Error(`projection not registered: ${key}`);
  }
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : -1;
  const cached = projectionCache.get(key);
  if (cached && cached.lastSeq === lastSeq) {
    return cached.state as S;
  }
  let state: S;
  let startIndex: number;
  if (cached && cached.lastSeq < lastSeq && cached.lastSeq + 1 <= events.length) {
    state = cached.state as S;
    startIndex = cached.lastSeq + 1;
  } else {
    state = projection.init();
    startIndex = 0;
  }
  for (let i = startIndex; i < events.length; i++) {
    state = projection.apply(state, events[i]!);
  }
  projectionCache.set(key, { lastSeq, state });
  return state;
}

export function foldProjections<S>(events: LogEvent[], projection: Projection<S>): S {
  return events.reduce(projection.apply, projection.init());
}

export class EventLog {
  private readonly dir: string;
  private readonly headerPath: string;
  private header?: SessionHeader;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private activeLogPath = "";

  constructor(taskId: string) {
    this.dir = path.join(DATA_DIR, "sessions", taskId);
    this.headerPath = path.join(this.dir, "header.json");
  }

  async init(taskId: string, cwd: string, migrations: Migration[] = []): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.headerPath, "utf8");
    } catch {
      raw = null;
    }

    if (raw === null) {
      const header: SessionHeader = {
        formatVersion: CURRENT_FORMAT_VERSION,
        taskId,
        createdAt: new Date().toISOString(),
        cwd,
        logFile: "events.jsonl",
      };
      this.activeLogPath = path.join(this.dir, "events.jsonl");
      await atomicWriteFile(this.headerPath, JSON.stringify(header, null, 2));
      await fs.writeFile(this.activeLogPath, "", "utf8");
      this.header = header;
      this.seq = 0;
      return;
    }

    const header = JSON.parse(raw) as SessionHeader;
    const logFile = header.logFile ?? "events.jsonl";
    const logPath = path.join(this.dir, logFile);
    try {
      await fs.access(logPath);
    } catch {
      await fs.writeFile(logPath, "", "utf8");
    }

    if (migrations.length > 0 && header.formatVersion < CURRENT_FORMAT_VERSION) {
      const chain = compileMigrationChain(migrations);
      if (header.formatVersion !== chain.from) {
        throw new MigrationChainError(
          `migration chain starts at v${chain.from} but session is v${header.formatVersion}`,
        );
      }
      const targetName = `events.v${chain.to}.jsonl`;
      const targetPath = path.join(this.dir, targetName);
      await migrateStreaming(logPath, targetPath, chain);
      const migratedHeader: SessionHeader = {
        ...chain.migrateHeader(header),
        formatVersion: chain.to,
        logFile: targetName,
      };
      await atomicWriteFile(this.headerPath, JSON.stringify(migratedHeader, null, 2));
      this.header = migratedHeader;
      this.activeLogPath = targetPath;
      const events = await this.readEvents(targetPath, false);
      this.seq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 0;
      return;
    }

    // Opening for write: repair a torn tail by truncating it.
    const events = await this.readEvents(logPath, true);
    this.header = header;
    this.activeLogPath = logPath;
    this.seq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 0;
  }

  private async readEvents(filePath: string, forWrite: boolean): Promise<LogEvent[]> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      return [];
    }
    const parsed = parseLogContent(content);
    if (parsed.tornOffset !== null && forWrite) {
      await fs.truncate(filePath, parsed.tornOffset);
    }
    return parsed.events;
  }

  /** Read-only view; never modifies the file. */
  async readLog(): Promise<LogEvent[]> {
    return this.readEvents(this.activeLogPath, false);
  }

  /**
   * Append one event. Writes are serialized through a single in-process queue so
   * concurrent callers keep contiguous seq order. Logging failures are swallowed
   * (warned) so they can never break the task.
   */
  async append(type: string, data: unknown): Promise<void> {
    const event: LogEvent = { seq: this.seq++, ts: Date.now(), type, data };
    const line = JSON.stringify(event) + "\n";
    this.queue = this.queue.then(async () => {
      try {
        await fs.appendFile(this.activeLogPath, line, "utf8");
      } catch (err) {
        console.warn(`[sessionLog] append failed: ${String(err)}`);
      }
    });
    return this.queue;
  }

  /** Turn boundary: drain pending writes and fsync the active generation file. */
  async flush(): Promise<void> {
    await this.queue;
    try {
      const handle = await fs.open(this.activeLogPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      console.warn(`[sessionLog] flush failed: ${String(err)}`);
    }
  }
}

/** Read-only reader for a session directory. Tolerates a torn final line. */
export async function readLog(dir: string): Promise<LogEvent[]> {
  const headerPath = path.join(dir, "header.json");
  const raw = await fs.readFile(headerPath, "utf8");
  const header = JSON.parse(raw) as SessionHeader;
  const logFile = header.logFile ?? "events.jsonl";
  const logPath = path.join(dir, logFile);
  let content: string;
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return parseLogContent(content).events;
}
