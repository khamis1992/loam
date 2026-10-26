import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FieldCipher, type KeyProvider } from "../crypto.js";
import type { LegalPipelineRun } from "../pipeline/types.js";

export const PIPELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  corpus_snapshot_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_matter ON pipeline_runs(matter_id, updated_at);
`;

export class PipelineStore {
  private readonly cipher: FieldCipher;
  constructor(private readonly db: DatabaseSync, keys: KeyProvider) { this.cipher = new FieldCipher(keys); }

  save(run: LegalPipelineRun): void {
    this.db.prepare(`INSERT INTO pipeline_runs(id,matter_id,kind,status,stage,input_sha256,corpus_snapshot_id,updated_at,payload_enc)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, stage=excluded.stage, updated_at=excluded.updated_at, payload_enc=excluded.payload_enc`)
      .run(run.id, run.matterId, run.kind, run.status, run.stage, run.inputSha256, run.corpusSnapshotId, run.updatedAt, this.cipher.sealJson(run, `pipeline:${run.id}`));
  }

  get(id: string): LegalPipelineRun | undefined {
    const row = this.db.prepare("SELECT payload_enc FROM pipeline_runs WHERE id=?").get(id) as { payload_enc?: string } | undefined;
    return row?.payload_enc ? this.cipher.openJson<LegalPipelineRun>(row.payload_enc, `pipeline:${id}`) : undefined;
  }

  list(matterId: string): LegalPipelineRun[] {
    const rows = this.db.prepare("SELECT id FROM pipeline_runs WHERE matter_id=? ORDER BY updated_at DESC").all(matterId) as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id)!).filter(Boolean);
  }

  create(input: Omit<LegalPipelineRun, "id" | "createdAt" | "updatedAt">): LegalPipelineRun {
    const at = new Date().toISOString();
    const run: LegalPipelineRun = { ...input, id: `run-${crypto.randomBytes(8).toString("hex")}`, createdAt: at, updatedAt: at };
    this.save(run);
    return run;
  }
}
