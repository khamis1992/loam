/** Hybrid REA evidence identity — REA_INTO_LOAM_INTEGRATION §6, §11 (repo appendix A8/A12).
 *  Loam's `EV####` ids stay the process id; every imported REA record additionally
 *  carries a `contentDigest` (`ev_` + sha256 over a semantic projection) so bundles
 *  verify on import and stay stable across runs. First-party `src/re` ReEvidence ids
 *  (`ev_` + 32 hex, Loam-internal) are a different namespace and are rejected here.
 *  `rea_observation` records never satisfy the pentest evidence gate by themselves. */
import { createHash } from "node:crypto";
import path from "node:path";
import { nextEvidenceId } from "./orchestrator.js";

/** A REA canonical Evidence record as exported by the server (only the fields the
 *  semantic projection needs are typed; unknown extras are preserved verbatim). */
export interface ReaEvidenceRecord {
  evidence_id?: string;
  subject?: { digest?: { sha256?: string }; format?: string; architecture?: string; name?: string; local_path?: string } & Record<string, unknown>;
  provider?: unknown;
  analysis_profile?: unknown;
  predicate_type?: unknown;
  operation?: unknown;
  parameters?: unknown;
  raw_result?: unknown;
  normalized_result?: unknown;
  confidence?: unknown;
  authority?: unknown;
  environment?: unknown;
  limitations?: unknown;
  relationship_coverage?: unknown;
  locations?: unknown;
  evidence_links?: unknown;
  [key: string]: unknown;
}

/** Loam-facing reference to an imported REA observation (hybrid identity, OD-1). */
export interface LoamEvidenceRef {
  /** Loam process id (EV####) — always present when created inside Loam. */
  id: string;
  /** REA content digest (`ev_` + 64 hex) — stable across imports. */
  contentDigest?: string;
  kind: "rea_observation";
  at: string;
  rea?: {
    operation?: string;
    providerId?: string;
    confidence?: string;
    authority?: string;
    limitations?: string[];
  };
  untrusted: true;
}

export class ReaIntegrityError extends Error {
  readonly code = "rea_integrity_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "ReaIntegrityError";
  }
}

/** Deterministic JSON: recursively sorted object keys, no whitespace (§6.3). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** The semantic projection the digest commits to (§6.3): everything that carries
 *  analytical meaning, excluding volatile identity (`subject.name`, `subject.local_path`). */
export function reaSemanticProjection(record: ReaEvidenceRecord): Record<string, unknown> {
  return {
    subject: {
      digest: record.subject?.digest ?? null,
      format: record.subject?.format ?? null,
      architecture: record.subject?.architecture ?? null,
    },
    provider: record.provider ?? null,
    analysis_profile: record.analysis_profile ?? null,
    predicate_type: record.predicate_type ?? null,
    operation: record.operation ?? null,
    parameters: record.parameters ?? null,
    raw_result: record.raw_result ?? null,
    normalized_result: record.normalized_result ?? null,
    confidence: record.confidence ?? null,
    authority: record.authority ?? null,
    environment: record.environment ?? null,
    limitations: record.limitations ?? null,
    relationship_coverage: record.relationship_coverage ?? null,
    locations: record.locations ?? null,
    evidence_links: record.evidence_links ?? null,
  };
}

/** REA content digest: `ev_` + sha256(canonical semantic projection). */
export function reaContentDigest(record: ReaEvidenceRecord): string {
  return `ev_${createHash("sha256").update(canonicalJson(reaSemanticProjection(record)), "utf8").digest("hex")}`;
}

/** True for the imported-server namespace (`ev_` + 64 hex). First-party `src/re`
 *  ReEvidence uses `ev_` + 32 hex and is NOT verified by this module (appendix A12). */
export function isReaServerEvidenceId(id: string): boolean {
  return /^ev_[a-f0-9]{64}$/.test(id);
}

/** Verify one record's declared `evidence_id` against its recomputed digest. */
export function verifyReaRecord(record: ReaEvidenceRecord): string {
  const id = record.evidence_id ?? "";
  if (!isReaServerEvidenceId(id)) {
    throw new ReaIntegrityError(`record id "${id}" is not a server evidence id (ev_ + 64 hex)`);
  }
  const recomputed = reaContentDigest(record);
  if (recomputed !== id) {
    throw new ReaIntegrityError(`digest mismatch: declared ${id}, recomputed ${recomputed}`);
  }
  return recomputed;
}

function toLoamRef(record: ReaEvidenceRecord, contentDigest: string, id: string): LoamEvidenceRef {
  const provider = record.provider as { id?: string } | undefined;
  return {
    id,
    contentDigest,
    kind: "rea_observation",
    at: new Date().toISOString(),
    rea: {
      operation: typeof record.operation === "string" ? record.operation : undefined,
      providerId: provider?.id,
      confidence: typeof record.confidence === "string" ? record.confidence : undefined,
      authority: typeof record.authority === "string" ? record.authority : undefined,
      limitations: Array.isArray(record.limitations) ? (record.limitations as string[]).filter((x) => typeof x === "string") : undefined,
    },
    untrusted: true,
  };
}

/** Import a REA bundle: verify every record's digest, then mint hybrid refs with
 *  fresh Loam `EV####` ids. Any mismatch rejects the whole bundle (§6.3). */
export function importReaBundle(raw: string, idGen: () => string = nextEvidenceId): LoamEvidenceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ReaIntegrityError(`bundle is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const container = parsed as { records?: unknown; evidence?: unknown } | unknown[];
  const list: unknown = Array.isArray(container) ? container : (container.records ?? container.evidence);
  if (!Array.isArray(list)) {
    throw new ReaIntegrityError("bundle has no records array");
  }
  return list.map((entry) => {
    const record = entry as ReaEvidenceRecord;
    const digest = verifyReaRecord(record);
    return toLoamRef(record, digest, idGen());
  });
}

/** Where exported bundles live inside a task workspace (§11.1). */
export function reaBundlePath(workspace: string, contentDigest: string): string {
  // Filename-safe: hex ids pass through verbatim; anything path-shaped is stripped.
  const safe = contentDigest.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(workspace, ".loam", "rea", "bundles", `${safe || "bundle"}.json`);
}
