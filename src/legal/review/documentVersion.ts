import crypto from "node:crypto";

export interface DocumentVersion {
  id: string;
  matterId: string;
  documentName: string;
  contentSha256: string;
  corpusSnapshotId: string;
  model: string;
  createdAt: string;
}

export function newDocumentVersion(input: Omit<DocumentVersion, "id" | "createdAt">, at = new Date().toISOString()): DocumentVersion {
  return { ...input, id: `dv-${crypto.createHash("sha256").update(`${input.matterId}|${input.documentName}|${input.contentSha256}`).digest("hex").slice(0, 12)}`, createdAt: at };
}
