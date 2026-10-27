/**
 * Licensed-lawyer review gate (lawyer-in-the-loop). A pure state machine:
 *
 *   draft --verify(pass)--> verified --submit--> in_review --approve--> approved
 *     ^                                             |  \--reject--> rejected
 *     +------------- any content change (sha256 differs) <-----------+
 *
 * Approval needs: a passing verification of exactly this text (same sha256),
 * zero UNVERIFIED markers left, and a reviewer name + Qatar licence number.
 * Only an approved record whose sha256 still matches may be exported "final";
 * everything else exports as a watermarked draft.
 */
import crypto from "node:crypto";
import type { ReviewComment, ReviewDecision, ReviewRecord, ReviewState, VerificationReport } from "./types.js";
import type { ApprovalArtifact } from "./review/approvalArtifact.js";

export class ReviewError extends Error {}

type Reviewer = { name: string; licenseNo: string };

export function newReview(matterId: string, documentName: string): ReviewRecord {
  return { id: `rv-${crypto.randomBytes(5).toString("hex")}`, matterId, documentName, state: "draft", history: [], comments: [], acceptedWarnings: [], decisions: [] };
}

function reviewerIdentity(reviewer: Reviewer): Reviewer {
  if (!reviewer.name.trim() || !reviewer.licenseNo.trim()) throw new ReviewError("reviewer name and licence number are required");
  return { name: reviewer.name.trim(), licenseNo: reviewer.licenseNo.trim() };
}

function decide(rec: ReviewRecord, action: ReviewDecision["action"], subject: string, reviewer: Reviewer, at: string, reason?: string): ReviewRecord {
  const decision: ReviewDecision = { id: `rd-${crypto.randomBytes(6).toString("hex")}`, action, actor: reviewerIdentity(reviewer), subject, ...(reason ? { reason } : {}), at };
  return { ...rec, decisions: [...(rec.decisions ?? []), decision] };
}

function move(rec: ReviewRecord, to: ReviewState, actor: string, at: string, patch: Partial<ReviewRecord> = {}): ReviewRecord {
  return { ...rec, ...patch, state: to, history: [...rec.history, { at, from: rec.state, to, actor }] };
}

export function markVerified(rec: ReviewRecord, report: VerificationReport, actor: string, at: string): ReviewRecord {
  if (report.verdict === "fail") throw new ReviewError("verification failed: fix every failing citation first");
  if (rec.state === "approved" && rec.approvedSha256 === report.documentSha256) return rec;
  return move(rec, "verified", actor, at, {
    verifiedSha256: report.documentSha256, verifiedCorpusSnapshotId: report.corpusSnapshotId, verification: report,
    approvedSha256: undefined, approvedCorpusSnapshotId: undefined, reviewer: undefined, acceptedWarnings: [],
  });
}

export function submitForReview(rec: ReviewRecord, actor: string, at: string): ReviewRecord {
  if (rec.state !== "verified") throw new ReviewError(`cannot submit from state ${rec.state}`);
  return move(rec, "in_review", actor, at);
}

export function approve(
  rec: ReviewRecord, report: VerificationReport, reviewer: Reviewer, at: string,
): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError(`cannot approve from state ${rec.state}`);
  const identity = reviewerIdentity(reviewer);
  if (report.verdict === "fail") throw new ReviewError("cannot approve a failing document");
  if (report.coverage.status !== "complete") throw new ReviewError(`cannot approve with corpus coverage ${report.coverage.status}; resolve every required source first`);
  if (report.documentSha256 !== rec.verifiedSha256) throw new ReviewError("document changed since verification; verify again");
  if (report.corpusSnapshotId !== rec.verifiedCorpusSnapshotId) throw new ReviewError("corpus changed since verification; verify again");
  if (report.counts.unverifiedMarkers > 0) throw new ReviewError("document still contains unverified markers");
  return decide(move(rec, "approved", `${identity.name} (${identity.licenseNo})`, at, {
    approvedSha256: report.documentSha256, approvedCorpusSnapshotId: report.corpusSnapshotId,
    reviewer: identity, decidedAt: at,
  }), "approve", rec.documentVersion?.id ?? rec.documentName, identity, at);
}

export function reject(rec: ReviewRecord, actor: string, note: string, at: string): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError(`cannot reject from state ${rec.state}`);
  return move(rec, "rejected", actor, at, { note: note.slice(0, 500), decidedAt: at });
}

export function addReviewComment(rec: ReviewRecord, input: { start: number; end: number; quote: string; body: string }, reviewer: Reviewer, at: string): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError("comments require an active lawyer review");
  const identity = reviewerIdentity(reviewer);
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end <= input.start) throw new ReviewError("invalid comment anchor");
  if (!input.quote.trim() || input.quote.length > 5000 || !input.body.trim() || input.body.length > 5000) throw new ReviewError("comment quote and body are required and must not exceed 5000 characters");
  const comment: ReviewComment = { id: `rc-${crypto.randomBytes(6).toString("hex")}`, anchor: { start: input.start, end: input.end, quote: input.quote }, body: input.body.trim(), author: identity, createdAt: at };
  return decide({ ...rec, comments: [...(rec.comments ?? []), comment] }, "comment", comment.id, identity, at, comment.body);
}

export function acceptReviewWarning(rec: ReviewRecord, input: { code: string; reason: string }, reviewer: Reviewer, at: string): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError("warning acceptance requires an active lawyer review");
  const identity = reviewerIdentity(reviewer);
  if (!rec.verification?.warnings.some((warning) => warning.code === input.code)) throw new ReviewError("warning is not present in this verification");
  if (input.reason.trim().length < 3 || input.reason.length > 1000) throw new ReviewError("a reason between 3 and 1000 characters is required");
  const acceptedWarnings = (rec.acceptedWarnings ?? []).filter((warning) => warning.code !== input.code);
  acceptedWarnings.push({ code: input.code, reason: input.reason.trim(), reviewer: identity, acceptedAt: at });
  return decide({ ...rec, acceptedWarnings }, "accept_warning", input.code, identity, at, input.reason.trim());
}

/** Any change to the text sends the record back to draft (approval does not survive edits). */
export function onContentChanged(rec: ReviewRecord, newSha256: string, actor: string, at: string): ReviewRecord {
  const anchor = rec.approvedSha256 ?? rec.verifiedSha256;
  if (!anchor || anchor === newSha256 || rec.state === "draft") return rec;
  return move(rec, "draft", actor, at, {
    verifiedSha256: undefined, approvedSha256: undefined, verification: undefined, sourceText: undefined, documentVersion: undefined,
    verifiedCorpusSnapshotId: undefined, approvedCorpusSnapshotId: undefined, comments: [], acceptedWarnings: [],
    approvedArtifactSha256: undefined, artifactId: undefined, reviewer: undefined,
  });
}

export function canExportFinal(rec: ReviewRecord, currentSha256: string): boolean {
  return rec.state === "approved" && rec.approvedSha256 === currentSha256;
}

export function canExportArtifact(rec: ReviewRecord, artifactSha256: string): boolean {
  return rec.state === "approved" && (rec.approvedArtifactSha256 ?? rec.approvedSha256) === artifactSha256;
}

export function approveArtifact(rec: ReviewRecord, artifact: ApprovalArtifact, reviewer: Reviewer, at: string): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError(`cannot approve from state ${rec.state}`);
  const identity = reviewerIdentity(reviewer);
  if (rec.verifiedSha256 !== artifact.contentSha256) throw new ReviewError("artifact content changed since verification");
  if (rec.verifiedCorpusSnapshotId !== artifact.corpusSnapshotId) throw new ReviewError("corpus changed since verification");
  if (artifact.dataBase64 && crypto.createHash("sha256").update(Buffer.from(artifact.dataBase64, "base64")).digest("hex") !== artifact.artifactSha256) throw new ReviewError("artifact hash mismatch");
  return decide(move(rec, "approved", `${identity.name} (${identity.licenseNo})`, at, {
    approvedSha256: artifact.contentSha256, approvedCorpusSnapshotId: artifact.corpusSnapshotId,
    approvedArtifactSha256: artifact.artifactSha256, artifactId: artifact.id,
    reviewer: identity, decidedAt: at,
  }), "approve", rec.documentVersion?.id ?? rec.documentName, identity, at);
}

export const DRAFT_WATERMARK_AR = "مسودة للمراجعة — لا تُقدَّم ولا تُرسَل قبل اعتماد محامٍ مرخّص في دولة قطر";
export const DISCLAIMER_AR = "هذه المخرجات أعدّها مساعد آلي لدعم العمل القانوني، وليست بديلاً عن رأي محامٍ مرخّص في دولة قطر، ولا تُعد استشارة قانونية.";
export const DISCLAIMER_EN = "Prepared by an AI assistant to support legal work. Not a substitute for a lawyer licensed in the State of Qatar; not legal advice.";
