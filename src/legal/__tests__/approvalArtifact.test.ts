import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { markVerified, newReview, submitForReview } from "../review.js";
import { canExportArtifact, approveArtifact } from "../review.js";
import type { ApprovalArtifact } from "../review/approvalArtifact.js";
import type { VerificationReport } from "../types.js";

test("approval artifact binds exact bytes, reviewer and encrypted export", () => {
  const store = new MattersStore(":memory:", new StaticKeyProvider(crypto.randomBytes(32)));
  const matter = store.createMatter({ title: "عقد", kind: "contract_review" }, "user");
  const bytes = Buffer.from("docx bytes", "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const report: VerificationReport = {
    verdict: "pass", asOf: "2092-01-01", checks: [], warnings: [], documentSha256: hash,
    corpusSnapshotId: "CS-1", coverage: { status: "complete", matterKind: "contract_review", asOf: "2092-01-01", entries: 1, issues: [], checkedAt: "2092-01-01" },
    counts: { cited: 0, verified: 0, failed: 0, freeMentions: 0, unverifiedMarkers: 0 },
  };
  let review = submitForReview(markVerified(newReview(matter.id, "redline:ct-1"), report, "user", "2092-01-01T00:00:00Z"), "user", "2092-01-01T00:00:00Z");
  const artifact: ApprovalArtifact = {
    id: "aa-1", reviewId: review.id, matterId: matter.id, documentName: "redline:ct-1", kind: "docx",
    contentSha256: hash, artifactSha256: hash, corpusSnapshotId: "CS-1", model: "qwen3.6:35b-a3b", dataBase64: bytes.toString("base64"), createdAt: "2092-01-01T00:00:00Z",
  };
  review = approveArtifact(review, artifact, { name: "مراجع", licenseNo: "1" }, "2092-01-01T00:00:00Z");
  store.saveReview(review);
  store.approvals.save(artifact);
  assert.equal(canExportArtifact(review, hash), true);
  assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM approval_artifacts").all()).includes("docx bytes"), false);
  assert.equal(store.approvals.latest(review.id)?.dataBase64, artifact.dataBase64);
  assert.equal(canExportArtifact(review, "0".repeat(64)), false);
  store.close();
});
