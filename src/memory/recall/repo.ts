import type { DatabaseSync } from "node:sqlite";
import { ensureRecallSchema, type SchemaStatus } from "./schema.js";
import type { MemoryKind, MemoryOrigin, MemoryRecord, MemoryRelation, MemoryState, RelationOrigin, RelationType } from "./types.js";
import { normalizeForIndex, tokenize } from "./normalize.js";
import { bufferToFloat32, float32ToBuffer } from "./vectors.js";

type Row = Record<string, unknown>;

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class RecallRepo {
  readonly schema: SchemaStatus;
  private inTx = false;

  constructor(readonly db: DatabaseSync) {
    this.schema = ensureRecallSchema(db);
  }

  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    } finally {
      this.inTx = false;
    }
  }

  insert(memory: MemoryRecord): void {
    this.db.prepare(`INSERT INTO recall_memories (
      id, scope, content, lang, kind, origin, importance, confidence, prominence, state, is_latest, pinned,
      confirmations, access_count, event_at, document_at, last_access_at, trashed_at, source_ref, tags,
      embedding, embedding_model, content_hash, decay_rate, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      memory.id, memory.scope, memory.content, memory.lang, memory.kind, memory.origin,
      memory.importance, memory.confidence, memory.prominence, memory.state, memory.isLatest ? 1 : 0, memory.pinned ? 1 : 0,
      memory.confirmations, memory.accessCount, memory.eventAt ?? null, memory.documentAt, memory.lastAccessAt ?? null,
      memory.trashedAt ?? null, memory.sourceRef ? JSON.stringify(memory.sourceRef) : null, JSON.stringify(memory.tags),
      memory.embedding ? float32ToBuffer(memory.embedding) : null, memory.embeddingModel ?? null, memory.contentHash,
      memory.decayRate ?? null, memory.createdAt, memory.updatedAt,
    );
    this.writeFts(memory.id, normalizeForIndex(memory.content));
    this.event(memory.id, "insert", memory.origin);
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM recall_memories WHERE id = ?").get(id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  findByHash(scope: string, hash: string): MemoryRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM recall_memories WHERE scope = ? AND content_hash = ? AND state <> 'trashed' ORDER BY is_latest DESC LIMIT 1",
    ).get(scope, hash) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  update(memory: MemoryRecord): void {
    this.db.prepare(`UPDATE recall_memories SET
      content=?, lang=?, kind=?, origin=?, importance=?, confidence=?, prominence=?, state=?, is_latest=?, pinned=?,
      confirmations=?, access_count=?, event_at=?, last_access_at=?, trashed_at=?, tags=?, embedding=?, embedding_model=?,
      decay_rate=?, updated_at=? WHERE id=?`).run(
      memory.content, memory.lang, memory.kind, memory.origin, memory.importance, memory.confidence, memory.prominence,
      memory.state, memory.isLatest ? 1 : 0, memory.pinned ? 1 : 0, memory.confirmations, memory.accessCount,
      memory.eventAt ?? null, memory.lastAccessAt ?? null, memory.trashedAt ?? null, JSON.stringify(memory.tags),
      memory.embedding ? float32ToBuffer(memory.embedding) : null, memory.embeddingModel ?? null,
      memory.decayRate ?? null, memory.updatedAt, memory.id,
    );
  }

  byState(states: MemoryState[]): MemoryRecord[] {
    const stateSql = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM recall_memories WHERE state IN (${stateSql})`).all(...states) as Row[]).map((row) => this.map(row));
  }

  latest(scopes: string[] | undefined, states: MemoryState[]): MemoryRecord[] {
    const wanted = states.length > 0 ? states : (["active", "dormant"] as MemoryState[]);
    const stateSql = wanted.map(() => "?").join(",");
    if (!scopes || scopes.length === 0) {
      return (this.db.prepare(
        `SELECT * FROM recall_memories WHERE is_latest = 1 AND state IN (${stateSql})`,
      ).all(...wanted) as Row[]).map((row) => this.map(row));
    }
    const scopeSql = scopes.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM recall_memories WHERE is_latest = 1 AND state IN (${stateSql}) AND scope IN (${scopeSql})`,
    ).all(...wanted, ...scopes) as Row[]).map((row) => this.map(row));
  }

  ftsRanks(query: string, scopes: string[] | undefined, states: MemoryState[], limit: number): Array<{ id: string; rank: number }> | null {
    if (!this.schema.fts) return null;
    const match = tokenize(query).slice(0, 12).map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
    if (!match) return [];
    const wanted = states.length > 0 ? states : (["active", "dormant"] as MemoryState[]);
    const stateSql = wanted.map(() => "?").join(",");
    const scopeSql = scopes && scopes.length > 0 ? ` AND m.scope IN (${scopes.map(() => "?").join(",")})` : "";
    try {
      const rows = this.db.prepare(`
        SELECT m.id AS id
        FROM recall_fts
        JOIN recall_memories m ON m.rowid = recall_fts.rowid
        WHERE recall_fts MATCH ?
          AND m.is_latest = 1
          AND m.state IN (${stateSql})${scopeSql}
        ORDER BY bm25(recall_fts)
        LIMIT ?
      `).all(match, ...wanted, ...(scopes ?? []), limit) as Row[];
      return rows.map((row, rank) => ({ id: text(row.id), rank }));
    } catch {
      return null;
    }
  }

  vectorScan(scopes: string[] | undefined, states: MemoryState[]): Array<{ id: string; documentAt: number; pinned: boolean; embedding?: Float32Array; embeddingModel?: string }> {
    const wanted = states.length > 0 ? states : (["active", "dormant"] as MemoryState[]);
    const stateSql = wanted.map(() => "?").join(",");
    const scopeSql = scopes && scopes.length > 0 ? ` AND scope IN (${scopes.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`
      SELECT id, document_at, pinned, embedding, embedding_model
      FROM recall_memories
      WHERE is_latest = 1 AND state IN (${stateSql})${scopeSql}
    `).all(...wanted, ...(scopes ?? [])) as Row[];
    return rows.map((row) => {
      const embedding = bufferToFloat32(row.embedding);
      return {
        id: text(row.id),
        documentAt: Number(row.document_at),
        pinned: Number(row.pinned) === 1,
        ...(embedding ? { embedding } : {}),
        ...(typeof row.embedding_model === "string" ? { embeddingModel: row.embedding_model } : {}),
      };
    });
  }

  countLatest(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM recall_memories WHERE is_latest = 1 AND state IN ('active','dormant')").get() as Row;
    return Number(row.n ?? 0);
  }

  temporal(since: number, until: number, scopes?: string[]): MemoryRecord[] {
    if (!scopes || scopes.length === 0) {
      return (this.db.prepare(
        "SELECT * FROM recall_memories WHERE state <> 'trashed' AND COALESCE(event_at, document_at) BETWEEN ? AND ? ORDER BY COALESCE(event_at, document_at) DESC",
      ).all(since, until) as Row[]).map((row) => this.map(row));
    }
    const scopeSql = scopes.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM recall_memories WHERE state <> 'trashed' AND scope IN (${scopeSql}) AND COALESCE(event_at, document_at) BETWEEN ? AND ? ORDER BY COALESCE(event_at, document_at) DESC`,
    ).all(...scopes, since, until) as Row[]).map((row) => this.map(row));
  }

  addRelation(rel: MemoryRelation): void {
    this.db.prepare(
      "INSERT INTO recall_relations(id, from_id, to_id, type, confidence, origin, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(from_id, to_id, type) DO UPDATE SET confidence=excluded.confidence",
    ).run(rel.id, rel.fromId, rel.toId, rel.type, rel.confidence, rel.origin, rel.createdAt);
  }

  relationsOf(id: string): MemoryRelation[] {
    return (this.db.prepare("SELECT * FROM recall_relations WHERE from_id = ? OR to_id = ?").all(id, id) as Row[]).map((row) => ({
      id: text(row.id),
      fromId: text(row.from_id),
      toId: text(row.to_id),
      type: text(row.type) as RelationType,
      confidence: Number(row.confidence ?? 0),
      origin: text(row.origin) as RelationOrigin,
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  replaceLsh(memoryId: string, scope: string, model: string, buckets: Array<{ table: number; bucket: number }>): void {
    this.db.prepare("DELETE FROM recall_lsh WHERE memory_id = ? AND model = ?").run(memoryId, model);
    const stmt = this.db.prepare("INSERT INTO recall_lsh(memory_id, scope, model, tbl, bucket) VALUES (?,?,?,?,?)");
    for (const item of buckets) stmt.run(memoryId, scope, model, item.table, item.bucket);
  }

  lshCandidates(model: string, scope: string | undefined, probes: Array<{ table: number; bucket: number }>): string[] {
    const ids = new Set<string>();
    const stmt = scope
      ? this.db.prepare("SELECT memory_id FROM recall_lsh WHERE model = ? AND tbl = ? AND bucket = ? AND scope = ?")
      : this.db.prepare("SELECT memory_id FROM recall_lsh WHERE model = ? AND tbl = ? AND bucket = ?");
    for (const probe of probes) {
      const rows = (scope ? stmt.all(model, probe.table, probe.bucket, scope) : stmt.all(model, probe.table, probe.bucket)) as Row[];
      for (const row of rows) ids.add(text(row.memory_id));
    }
    return [...ids];
  }

  bumpAccess(id: string, at: number): void {
    this.db.prepare("UPDATE recall_memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?").run(at, id);
  }

  confirm(id: string, at: number): void {
    this.db.prepare("UPDATE recall_memories SET confirmations = confirmations + 1, updated_at = ?, prominence = MIN(1, prominence + 0.05) WHERE id = ?").run(at, id);
    this.event(id, "confirm");
  }

  hardDelete(id: string): void {
    const row = this.schema.fts
      ? this.db.prepare("SELECT rowid AS rid, content FROM recall_memories WHERE id = ?").get(id) as Row | undefined
      : undefined;
    this.event(id, "delete");
    this.db.prepare("DELETE FROM recall_memories WHERE id = ?").run(id);
    if (row) {
      this.db.prepare("INSERT INTO recall_fts(recall_fts, rowid, norm_content) VALUES ('delete', ?, ?)").run(
        Number(row.rid),
        normalizeForIndex(text(row.content)),
      );
    }
  }

  event(memoryId: string | undefined, kind: string, detail?: unknown): void {
    this.db.prepare("INSERT INTO recall_events(id, memory_id, kind, detail, at) VALUES (?,?,?,?,?)").run(
      `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      memoryId ?? null,
      kind,
      detail === undefined ? null : JSON.stringify(detail),
      Date.now(),
    );
  }

  eventsFor(memoryId: string): string[] {
    return (this.db.prepare("SELECT kind FROM recall_events WHERE memory_id = ? ORDER BY at").all(memoryId) as Row[]).map((row) => text(row.kind));
  }

  enqueue(id: string, payload: unknown, nextAt: number): void {
    this.db.prepare("INSERT INTO recall_ingest_queue(id, payload, attempts, next_at) VALUES (?,?,0,?)").run(id, JSON.stringify(payload), nextAt);
  }

  dueQueue(now: number, limit = 5): Array<{ id: string; payload: string; attempts: number }> {
    return (this.db.prepare("SELECT id, payload, attempts FROM recall_ingest_queue WHERE next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as Row[]).map((row) => ({
      id: text(row.id),
      payload: text(row.payload),
      attempts: Number(row.attempts ?? 0),
    }));
  }

  finishQueue(id: string): void {
    this.db.prepare("DELETE FROM recall_ingest_queue WHERE id = ?").run(id);
  }

  failQueue(id: string, attempts: number, nextAt: number, error: string): void {
    this.db.prepare("UPDATE recall_ingest_queue SET attempts = ?, next_at = ?, error = ? WHERE id = ?").run(attempts, nextAt, error.slice(0, 400), id);
  }

  saveRun(id: string, tick: string, catchUp: boolean, started: number, report: unknown): void {
    this.db.prepare("INSERT INTO recall_gardener_runs(id, tick, catch_up, started_at, finished_at, report) VALUES (?,?,?,?,?,?)").run(
      id, tick, catchUp ? 1 : 0, started, started, JSON.stringify(report),
    );
  }

  lastSleepAt(): number | undefined {
    const row = this.db.prepare("SELECT finished_at FROM recall_gardener_runs WHERE tick = 'sleep' ORDER BY finished_at DESC LIMIT 1").get() as Row | undefined;
    return row ? Number(row.finished_at) : undefined;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM recall_settings WHERE key = ?").get(key) as Row | undefined;
    return row ? text(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO recall_settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  coreGet(scope: string, block: string): string[] {
    const row = this.db.prepare("SELECT entries FROM recall_core WHERE scope = ? AND block = ?").get(scope, block) as Row | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(text(row.entries)) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  coreSet(scope: string, block: string, entries: string[], history: { id: string; op: string; before: string[]; after: string[]; at: number }): void {
    this.db.prepare("INSERT INTO recall_core(scope, block, entries, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, block) DO UPDATE SET entries=excluded.entries, updated_at=excluded.updated_at").run(
      scope, block, JSON.stringify(entries), history.at,
    );
    this.db.prepare("INSERT INTO recall_core_history(id, scope, block, op, before, after, at) VALUES (?,?,?,?,?,?,?)").run(
      history.id, scope, block, history.op, JSON.stringify(history.before), JSON.stringify(history.after), history.at,
    );
  }

  coreHistory(id: string): { scope: string; block: string; before: string[] } | undefined {
    const row = this.db.prepare("SELECT scope, block, before FROM recall_core_history WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const before = JSON.parse(text(row.before) || "[]") as unknown;
    return {
      scope: text(row.scope),
      block: text(row.block),
      before: Array.isArray(before) ? before.filter((item): item is string => typeof item === "string") : [],
    };
  }

  stats(): { total: number; byState: Record<string, number>; byScope: Record<string, number> } {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM recall_memories").get() as Row).n ?? 0);
    const byState: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT state, COUNT(*) AS n FROM recall_memories GROUP BY state").all() as Row[]) {
      byState[text(row.state)] = Number(row.n ?? 0);
    }
    const byScope: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT scope, COUNT(*) AS n FROM recall_memories GROUP BY scope").all() as Row[]) {
      byScope[text(row.scope)] = Number(row.n ?? 0);
    }
    return { total, byState, byScope };
  }

  containsText(fragment: string): boolean {
    const row = this.db.prepare("SELECT 1 AS hit FROM recall_memories WHERE content LIKE ? LIMIT 1").get(`%${fragment}%`) as Row | undefined;
    return Boolean(row);
  }

  private writeFts(id: string, content: string): void {
    if (!this.schema.fts) return;
    const row = this.db.prepare("SELECT rowid AS rid FROM recall_memories WHERE id = ?").get(id) as Row | undefined;
    if (!row) return;
    const rid = Number(row.rid);
    this.db.prepare("INSERT INTO recall_fts(rowid, norm_content) VALUES (?, ?)").run(rid, content);
  }

  private map(row: Row): MemoryRecord {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(text(row.tags) || "[]") as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === "string");
    } catch { tags = []; }
    let sourceRef: MemoryRecord["sourceRef"];
    if (typeof row.source_ref === "string" && row.source_ref) {
      try { sourceRef = JSON.parse(row.source_ref) as MemoryRecord["sourceRef"]; } catch { sourceRef = undefined; }
    }
    return {
      id: text(row.id),
      scope: text(row.scope),
      content: text(row.content),
      lang: (text(row.lang) || "en") as MemoryRecord["lang"],
      kind: text(row.kind) as MemoryKind,
      origin: text(row.origin) as MemoryOrigin,
      importance: Number(row.importance ?? 5),
      confidence: Number(row.confidence ?? 0.8),
      prominence: Number(row.prominence ?? 1),
      state: text(row.state) as MemoryState,
      isLatest: Number(row.is_latest) === 1,
      pinned: Number(row.pinned) === 1,
      confirmations: Number(row.confirmations ?? 0),
      accessCount: Number(row.access_count ?? 0),
      ...(num(row.event_at) !== undefined ? { eventAt: Number(row.event_at) } : {}),
      documentAt: Number(row.document_at ?? 0),
      ...(num(row.last_access_at) !== undefined ? { lastAccessAt: Number(row.last_access_at) } : {}),
      ...(num(row.trashed_at) !== undefined ? { trashedAt: Number(row.trashed_at) } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      tags,
      ...(typeof row.embedding_model === "string" ? { embeddingModel: row.embedding_model } : {}),
      ...(bufferToFloat32(row.embedding) ? { embedding: bufferToFloat32(row.embedding) } : {}),
      contentHash: text(row.content_hash),
      ...(num(row.decay_rate) !== undefined ? { decayRate: Number(row.decay_rate) } : {}),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}
