/**
 * C5: local tracing. OTel-shaped spans stored in manus.db (table trace_spans),
 * W3C traceparent propagation into subagents and ACP children, no network
 * export unless the user typed an OTLP endpoint (OD-4).
 */
import { createHash, randomBytes } from "node:crypto";
import { database } from "../../server/sqliteStore.js";
import { LOAM } from "./genai.js";

export type AttrValue = string | number | boolean | string[];
export type Attributes = Record<string, AttrValue>;
export type SpanKind = "internal" | "client" | "server";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export interface SpanEvent {
  name: string;
  atMs: number;
  attributes?: Attributes;
}

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttrValue): void;
  setAttributes(attrs: Attributes): void;
  addEvent(name: string, attrs?: Attributes): void;
  /** Records size + hash (and text only when captureContent is on). */
  recordContent(direction: "input" | "output", text: string): void;
  end(status?: SpanStatus, message?: string): void;
}

export interface StartSpanOptions {
  parent?: SpanContext | string;
  kind?: SpanKind;
  attributes?: Attributes;
  sessionId?: string;
  taskId?: string;
}

export interface TracerOptions {
  enabled: boolean;
  sampleRate: number;
  captureContent: boolean;
  maxSpansPerTrace: number;
  now?: () => number;
  random?: () => number;
}

export const TRACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trace_spans (
  trace_id TEXT NOT NULL CHECK (length(trace_id) = 32),
  span_id TEXT NOT NULL CHECK (length(span_id) = 16),
  parent_span_id TEXT CHECK (parent_span_id IS NULL OR length(parent_span_id) = 16),
  session_id TEXT,
  task_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('internal', 'client', 'server')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'unset' CHECK (status IN ('unset', 'ok', 'error')),
  status_message TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  events TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events)),
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS trace_spans_task ON trace_spans (task_id, start_ms);
CREATE INDEX IF NOT EXISTS trace_spans_start ON trace_spans (start_ms);
`;

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(c: SpanContext): string {
  return `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}`;
}

export function parseTraceparent(header: string | undefined): SpanContext | undefined {
  const m = TRACEPARENT_RE.exec((header ?? "").trim().toLowerCase());
  if (!m || /^0+$/.test(m[1] ?? "") || /^0+$/.test(m[2] ?? "")) return undefined;
  return { traceId: m[1] as string, spanId: m[2] as string, sampled: ((parseInt(m[3] as string, 16) & 1) === 1) };
}

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/** Secrets are scrubbed from every stored string, whatever captureContent says. */
export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, "[redacted]");
}

export function sha12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

let schemaReady = false;
function db() {
  const d = database();
  if (!schemaReady) {
    d.exec(TRACE_SCHEMA_SQL);
    schemaReady = true;
  }
  return d;
}

/** Test hook: call after resetDb(). */
export function resetTraceSchemaFlag(): void {
  schemaReady = false;
}

class NoopSpan implements Span {
  constructor(readonly context: SpanContext) {}
  setAttribute(): void {}
  setAttributes(): void {}
  addEvent(): void {}
  recordContent(): void {}
  end(): void {}
}

class StoredSpan implements Span {
  private attrs: Attributes;
  private events: SpanEvent[] = [];
  private ended = false;
  constructor(
    readonly context: SpanContext,
    private readonly opts: TracerOptions,
    private readonly now: () => number,
    attrs: Attributes,
  ) {
    this.attrs = { ...attrs };
  }
  setAttribute(key: string, value: AttrValue): void {
    this.attrs[key] = typeof value === "string" ? redactSecrets(value).slice(0, 2000) : value;
  }
  setAttributes(attrs: Attributes): void {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  addEvent(name: string, attrs?: Attributes): void {
    if (this.events.length < 64) this.events.push({ name, atMs: this.now(), attributes: attrs });
  }
  recordContent(direction: "input" | "output", text: string): void {
    const chars = direction === "input" ? LOAM.inputChars : LOAM.outputChars;
    const hash = direction === "input" ? LOAM.inputHash : LOAM.outputHash;
    this.attrs[chars] = text.length;
    this.attrs[hash] = sha12(text);
    if (this.opts.captureContent) this.attrs[`loam.${direction}.text`] = redactSecrets(text).slice(0, 8000);
  }
  end(status: SpanStatus = "ok", message?: string): void {
    if (this.ended) return;
    this.ended = true;
    db()
      .prepare("UPDATE trace_spans SET end_ms = ?, status = ?, status_message = ?, attributes = ?, events = ? WHERE trace_id = ? AND span_id = ?")
      .run(this.now(), status, message ? redactSecrets(message).slice(0, 500) : null, JSON.stringify(this.attrs), JSON.stringify(this.events), this.context.traceId, this.context.spanId);
  }
}

export class Tracer {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly spanCounts = new Map<string, number>();
  constructor(private readonly opts: TracerOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  startSpan(name: string, o: StartSpanOptions = {}): Span {
    const parent = typeof o.parent === "string" ? parseTraceparent(o.parent) : o.parent;
    const traceId = parent?.traceId ?? randomBytes(16).toString("hex");
    const sampled = parent ? parent.sampled : this.opts.enabled && this.random() < this.opts.sampleRate;
    const context: SpanContext = { traceId, spanId: randomBytes(8).toString("hex"), sampled };
    if (!this.opts.enabled || !sampled) return new NoopSpan(context);
    const count = (this.spanCounts.get(traceId) ?? 0) + 1;
    this.spanCounts.set(traceId, count);
    if (count > this.opts.maxSpansPerTrace) return new NoopSpan(context);
    const attrs: Attributes = { ...(o.attributes ?? {}) };
    if (o.taskId) attrs[LOAM.taskId] = o.taskId;
    db()
      .prepare("INSERT INTO trace_spans (trace_id, span_id, parent_span_id, session_id, task_id, name, kind, start_ms, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(traceId, context.spanId, parent?.spanId ?? null, o.sessionId ?? null, o.taskId ?? null, name, o.kind ?? "internal", this.now(), JSON.stringify(attrs));
    return new StoredSpan(context, this.opts, this.now, attrs);
  }

  async withSpan<T>(name: string, o: StartSpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.startSpan(name, o);
    try {
      const out = await fn(span);
      span.end("ok");
      return out;
    } catch (err) {
      span.end("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

export interface StoredSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  taskId: string | null;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number | null;
  status: SpanStatus;
  statusMessage: string | null;
  attributes: Attributes;
  events: SpanEvent[];
}

interface RawRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  task_id: string | null;
  name: string;
  kind: SpanKind;
  start_ms: number;
  end_ms: number | null;
  status: SpanStatus;
  status_message: string | null;
  attributes: string;
  events: string;
}

function toRow(r: RawRow): StoredSpanRow {
  return {
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    taskId: r.task_id,
    name: r.name,
    kind: r.kind,
    startMs: r.start_ms,
    endMs: r.end_ms,
    status: r.status,
    statusMessage: r.status_message,
    attributes: JSON.parse(r.attributes) as Attributes,
    events: JSON.parse(r.events) as SpanEvent[],
  };
}

export function spansForTask(taskId: string, limit = 5000): StoredSpanRow[] {
  const rows = db().prepare("SELECT * FROM trace_spans WHERE task_id = ? ORDER BY start_ms, rowid LIMIT ?").all(taskId, Math.min(limit, 50_000)) as unknown as RawRow[];
  return rows.map(toRow);
}

export function spansForTrace(traceId: string): StoredSpanRow[] {
  const rows = db().prepare("SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_ms, rowid").all(traceId) as unknown as RawRow[];
  return rows.map(toRow);
}

/** Deletes spans older than retainDays. Called by the existing daily housekeeping job. */
export function pruneSpans(retainDays: number, now = Date.now()): number {
  const cutoff = now - retainDays * 86_400_000;
  return Number(db().prepare("DELETE FROM trace_spans WHERE start_ms < ?").run(cutoff).changes);
}

/** OTLP/HTTP JSON body for an opt-in export. Never called when otlpEndpoint is "". */
export function toOtlpJson(spans: StoredSpanRow[]): unknown {
  const attr = (a: Attributes) =>
    Object.entries(a).map(([key, v]) => ({
      key,
      value: Array.isArray(v)
        ? { arrayValue: { values: v.map((s) => ({ stringValue: s })) } }
        : typeof v === "number"
          ? Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
          : typeof v === "boolean" ? { boolValue: v } : { stringValue: v },
    }));
  return {
    resourceSpans: [{
      resource: { attributes: attr({ "service.name": "loam" }) },
      scopeSpans: [{
        scope: { name: "loam.orchestration" },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? undefined,
          name: s.name,
          kind: s.kind === "client" ? 3 : s.kind === "server" ? 2 : 1,
          startTimeUnixNano: `${s.startMs}000000`,
          endTimeUnixNano: `${s.endMs ?? s.startMs}000000`,
          attributes: attr(s.attributes),
          status: { code: s.status === "ok" ? 1 : s.status === "error" ? 2 : 0, message: s.statusMessage ?? undefined },
        })),
      }],
    }],
  };
}

export async function exportOtlp(endpoint: string, spans: StoredSpanRow[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!endpoint || spans.length === 0) return false;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const res = await fetchImpl(new URL("/v1/traces", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toOtlpJson(spans)),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}
