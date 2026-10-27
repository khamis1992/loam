import { randomUUID } from "node:crypto";
import { allEntities, getEntity, putEntity, removeEntity } from "../../../server/sqliteStore.js";
import { createSourceAnchor, hashSourceText } from "../citations.js";
import { isRecord, OfficeIntelligenceError, type OfficeScope, type SourceAnchor } from "../contracts.js";
import { normalizeLegalName, validateLegalSource, type LegalSource } from "./qatar.js";

const LEGAL_SOURCE_KIND = "office-legal-sources";

export interface LegalSourceRecord extends LegalSource {
  tenantId: string;
  projectId?: string;
  matterId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function required(value: unknown, name: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new OfficeIntelligenceError(`${name} is required`, 422, "invalid_legal_source");
  return value.trim();
}

export function parseLegalSourceInput(value: unknown): LegalSourceRecord {
  if (!isRecord(value)) throw new OfficeIntelligenceError("legal source body is required", 422, "invalid_legal_source");
  const now = new Date().toISOString();
  const record: LegalSourceRecord = {
    id: typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id) ? value.id : `legal_${randomUUID()}`,
    tenantId: required(value.tenantId, "tenantId", 200),
    ...(value.projectId ? { projectId: required(value.projectId, "projectId", 200) } : {}),
    ...(value.matterId ? { matterId: required(value.matterId, "matterId", 200) } : {}),
    title: required(value.title, "title", 500),
    citation: required(value.citation, "citation", 500),
    sourceUrl: required(value.sourceUrl, "sourceUrl", 2000),
    issuer: required(value.issuer, "issuer", 500),
    text: required(value.text, "text", 200_000),
    effectiveFrom: required(value.effectiveFrom, "effectiveFrom", 40),
    ...(value.effectiveTo ? { effectiveTo: required(value.effectiveTo, "effectiveTo", 40) } : {}),
    retrievedAt: required(value.retrievedAt, "retrievedAt", 40),
    official: value.official === true,
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: now,
  };
  validateLegalSource(record, new Date(record.effectiveFrom));
  return record;
}

export function registerLegalSource(input: unknown): LegalSourceRecord {
  const parsed = parseLegalSourceInput(input);
  const existing = getEntity<LegalSourceRecord>(LEGAL_SOURCE_KIND, parsed.id);
  if (existing && existing.tenantId !== parsed.tenantId) throw new OfficeIntelligenceError("legal source id belongs to another tenant", 409, "source_conflict");
  if (existing && parsed.revision !== existing.revision + 1) throw new OfficeIntelligenceError("legal source revision conflict", 409, "revision_conflict");
  const saved: LegalSourceRecord = { ...parsed, revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt ?? parsed.createdAt };
  putEntity(LEGAL_SOURCE_KIND, saved);
  return saved;
}

export function getLegalSource(id: string): LegalSourceRecord | undefined {
  return getEntity<LegalSourceRecord>(LEGAL_SOURCE_KIND, id);
}

export function deleteLegalSource(id: string, expectedRevision: number): void {
  const existing = getEntity<LegalSourceRecord>(LEGAL_SOURCE_KIND, id);
  if (!existing) throw new OfficeIntelligenceError("legal source not found", 404, "source_not_found");
  if (existing.revision !== expectedRevision) throw new OfficeIntelligenceError("legal source revision conflict", 409, "revision_conflict");
  removeEntity(LEGAL_SOURCE_KIND, id);
}

function allowed(record: LegalSourceRecord, scope: OfficeScope): boolean {
  if (record.tenantId !== scope.tenantId) return false;
  if (scope.projectId && record.projectId && record.projectId !== scope.projectId) return false;
  if (scope.matterId && record.matterId && record.matterId !== scope.matterId) return false;
  return true;
}

export function listLegalSources(scope: OfficeScope, at = new Date()): LegalSourceRecord[] {
  return allEntities<LegalSourceRecord>(LEGAL_SOURCE_KIND).filter((record) => {
    if (!allowed(record, scope)) return false;
    const from = Date.parse(record.effectiveFrom);
    const to = record.effectiveTo ? Date.parse(record.effectiveTo) : Number.POSITIVE_INFINITY;
    return from <= at.getTime() && to >= at.getTime();
  });
}

export function legalSourceAnchor(record: LegalSourceRecord): SourceAnchor {
  const contentHash = hashSourceText(record.text);
  return createSourceAnchor({
    artifact: {
      taskId: "legal-library",
      path: `official/${record.id}`,
      kind: "document",
      revision: record.revision,
      contentHash,
      tenantId: record.tenantId,
    },
    kind: "file",
    anchor: record.citation,
    text: `${record.title}\n${record.issuer}\n${record.citation}\n${record.text}`,
  });
}

export function searchLegalSources(scope: OfficeScope, query: string, options?: { at?: Date; limit?: number }): LegalSourceRecord[] {
  const terms = [...new Set(normalizeLegalName(query).split(" ").filter((term) => term.length >= 2))].slice(0, 30);
  const limit = Math.min(Math.max(options?.limit ?? 8, 1), 30);
  return listLegalSources(scope, options?.at).map((record) => {
    const title = normalizeLegalName(`${record.title} ${record.citation} ${record.issuer}`);
    const body = normalizeLegalName(record.text);
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 4;
      if (body.includes(term)) score += 1;
    }
    return { record, score };
  }).filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
    .slice(0, limit)
    .map((entry) => entry.record);
}
