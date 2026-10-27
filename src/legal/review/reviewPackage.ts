import type { Matter, ReviewRecord } from "../types.js";
import type { ApprovalArtifact } from "./approvalArtifact.js";
import { DISCLAIMER_AR, DISCLAIMER_EN, DRAFT_WATERMARK_AR } from "../review.js";

export function buildReviewPackage(matter: Matter, review: ReviewRecord, artifact: ApprovalArtifact | undefined, generatedAt: string): string {
  return `${JSON.stringify({
    format: "loam-legal-review-package", version: 1, internal: true, generatedAt,
    watermark: review.state === "approved" ? undefined : DRAFT_WATERMARK_AR,
    disclaimers: { ar: DISCLAIMER_AR, en: DISCLAIMER_EN },
    matter, documentVersion: review.documentVersion, review,
    verification: review.verification,
    artifact: artifact ? { ...artifact, dataBase64: undefined } : undefined,
  }, null, 2)}\n`;
}
