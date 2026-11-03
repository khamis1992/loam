import { createHash } from "node:crypto";

export interface EvidenceBundle {
  version: 1;
  exportedAt: string;
  /** Loam EV#### id */
  loamId: string;
  /** REA-style content digest (ev_ + 32 hex) */
  contentDigest: string;
  records: Array<{ path: string; sha256: string; bytes: number }>;
}

export function contentDigest(payload: string | Buffer): string {
  const hex = createHash("sha256").update(payload).digest("hex");
  return `ev_${hex.slice(0, 32)}`;
}

export function buildBundle(loamId: string, files: Array<{ path: string; data: Buffer }>): EvidenceBundle {
  const records = files.map((f) => ({
    path: f.path,
    sha256: createHash("sha256").update(f.data).digest("hex"),
    bytes: f.data.length,
  }));
  const material = records.map((r) => `${r.path}:${r.sha256}`).sort().join("\n");
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    loamId,
    contentDigest: contentDigest(material),
    records,
  };
}

export function verifyBundle(bundle: EvidenceBundle, files: Array<{ path: string; data: Buffer }>): { ok: boolean; reason?: string } {
  const rebuilt = buildBundle(bundle.loamId, files);
  if (rebuilt.contentDigest !== bundle.contentDigest) return { ok: false, reason: "contentDigest_mismatch" };
  if (rebuilt.records.length !== bundle.records.length) return { ok: false, reason: "record_count" };
  return { ok: true };
}
