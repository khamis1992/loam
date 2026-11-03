// src/appbuilder/runtimeErrors.ts — runtime error store + "Fix with Engineer" prompt builder (MISSING §4.8.4)
import { randomBytes } from "node:crypto";
import { redactSecrets } from "./redact.js";
import type { RuntimeErrorKind, RuntimeErrorRecord, SourceLocation } from "./types.js";

/** Must equal PREFIX in templates/web-app/plugins/loam-runtime-bridge.ts. */
export const BRIDGE_PREFIX = "@@loam-runtime@@ ";

export interface BridgeError {
  kind: RuntimeErrorKind;
  message: string;
  stack: string | null;
  source: { file: string; line: number; column: number } | null;
  url: string | null;
}

/** Parse one dev-server stdout line into a bridge error (null when not a bridge line). */
export function parseBridgeLine(line: string): BridgeError | null {
  if (!line.startsWith(BRIDGE_PREFIX)) return null;
  try {
    const e = JSON.parse(line.slice(BRIDGE_PREFIX.length)) as Partial<BridgeError>;
    if (!e || typeof e.message !== "string") return null;
    return {
      kind: (e.kind as RuntimeErrorKind) ?? "error",
      message: e.message.slice(0, 2000),
      stack: typeof e.stack === "string" ? e.stack.slice(0, 6000) : null,
      source: e.source && typeof e.source.file === "string" ? { file: e.source.file, line: e.source.line ?? 0, column: e.source.column ?? 0 } : null,
      url: typeof e.url === "string" ? e.url : null,
    };
  } catch {
    return null;
  }
}

const records = new Map<string, RuntimeErrorRecord>();
const order: string[] = [];
const MAX_RECORDS = 200;

function recordKey(e: BridgeError): string {
  return `${e.kind}|${e.message}|${e.source ? `${e.source.file}:${e.source.line}` : ""}`;
}

/** Record (dedup by key, count up); returns the record when this is the FIRST occurrence. */
export function recordRuntimeError(projectId: string, e: BridgeError, now = new Date()): RuntimeErrorRecord | undefined {
  const key = recordKey(e);
  const existing = records.get(key);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = now.toISOString();
    return undefined;
  }
  const rec: RuntimeErrorRecord = {
    id: `re_${randomBytes(6).toString("hex")}`,
    projectId,
    kind: e.kind,
    message: redactSecrets(e.message),
    stack: e.stack ? redactSecrets(e.stack) : null,
    source: (e.source as SourceLocation | null) ?? null,
    url: e.url,
    count: 1,
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  records.set(key, rec);
  order.push(key);
  if (order.length > MAX_RECORDS) {
    const drop = order.shift()!;
    records.delete(drop);
  }
  return rec;
}

export function listRuntimeErrors(projectId: string): RuntimeErrorRecord[] {
  return order.map((k) => records.get(k)!).filter((r) => r && r.projectId === projectId);
}

export function clearRuntimeErrors(projectId: string): number {
  let n = 0;
  for (const [k, r] of records) {
    if (r.projectId === projectId) { records.delete(k); n++; }
  }
  order.length = 0;
  for (const k of records.keys()) order.push(k);
  return n;
}

/** The "Fix with Engineer" composer prompt from a runtime error record. */
export function fixPromptFor(record: RuntimeErrorRecord): string {
  const loc = record.source ? ` at ${record.source.file}:${record.source.line}` : "";
  return [
    `@Engineer Web page running error, console log is: ${record.message}${loc}`,
    record.stack ? record.stack.slice(0, 1200) : "",
  ].filter(Boolean).join("\n");
}
