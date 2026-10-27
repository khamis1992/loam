import type { DatabaseSync } from "node:sqlite";
import { FieldCipher, type KeyProvider } from "../crypto.js";

export interface ApprovalArtifact {
  id: string;
  reviewId: string;
  matterId: string;
  documentName: string;
  kind: "docx" | "markdown" | "json";
  contentSha256: string;
  artifactSha256: string;
  corpusSnapshotId: string;
  playbookVersion?: string;
  model: string;
  dataBase64?: string;
  createdAt: string;
}

export const APPROVAL_ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_artifacts (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  corpus_snapshot_id TEXT NOT NULL,
  playbook_version TEXT,
  model TEXT NOT NULL,
  data_enc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_artifacts_review ON approval_artifacts(review_id, created_at);
`;

export class ApprovalArtifactStore {
  private readonly cipher: FieldCipher;
  constructor(private readonly db: DatabaseSync, keys: KeyProvider) { this.cipher = new FieldCipher(keys); }

  save(artifact: ApprovalArtifact): void {
    this.db.prepare(`INSERT INTO approval_artifacts(id,review_id,matter_id,document_name,kind,content_sha256,artifact_sha256,corpus_snapshot_id,playbook_version,model,data_enc,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      artifact.id, artifact.reviewId, artifact.matterId, artifact.documentName, artifact.kind, artifact.contentSha256,
      artifact.artifactSha256, artifact.corpusSnapshotId, artifact.playbookVersion ?? null, artifact.model,
      artifact.dataBase64 ? this.cipher.seal(artifact.dataBase64, `approval-artifact:${artifact.id}`) : null, artifact.createdAt,
    );
  }

  latest(reviewId: string): ApprovalArtifact | undefined {
    const row = this.db.prepare("SELECT * FROM approval_artifacts WHERE review_id=? ORDER BY created_at DESC LIMIT 1").get(reviewId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), reviewId: String(row.review_id), matterId: String(row.matter_id), documentName: String(row.document_name),
      kind: String(row.kind) as ApprovalArtifact["kind"], contentSha256: String(row.content_sha256), artifactSha256: String(row.artifact_sha256),
      corpusSnapshotId: String(row.corpus_snapshot_id), ...(row.playbook_version ? { playbookVersion: String(row.playbook_version) } : {}),
      model: String(row.model), ...(row.data_enc ? { dataBase64: this.cipher.open(String(row.data_enc), `approval-artifact:${String(row.id)}`) } : {}), createdAt: String(row.created_at),
    };
  }
}
