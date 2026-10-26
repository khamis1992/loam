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
import type { ReviewRecord, ReviewState, VerificationReport } from "./types.js";

export class ReviewError extends Error {}

export function newReview(matterId: string, documentName: string): ReviewRecord {
  return { id: `rv-${crypto.randomBytes(5).toString("hex")}`, matterId, documentName, state: "draft", history: [] };
}

function move(rec: ReviewRecord, to: ReviewState, actor: string, at: string, patch: Partial<ReviewRecord> = {}): ReviewRecord {
  return { ...rec, ...patch, state: to, history: [...rec.history, { at, from: rec.state, to, actor }] };
}

export function markVerified(rec: ReviewRecord, report: VerificationReport, actor: string, at: string): ReviewRecord {
  if (report.verdict === "fail") throw new ReviewError("verification failed: fix every failing citation first");
  if (rec.state === "approved" && rec.approvedSha256 === report.documentSha256) return rec;
  return move(rec, "verified", actor, at, {
    verifiedSha256: report.documentSha256, verifiedCorpusSnapshotId: report.corpusSnapshotId,
    approvedSha256: undefined, approvedCorpusSnapshotId: undefined, reviewer: undefined,
  });
}

export function submitForReview(rec: ReviewRecord, actor: string, at: string): ReviewRecord {
  if (rec.state !== "verified") throw new ReviewError(`cannot submit from state ${rec.state}`);
  return move(rec, "in_review", actor, at);
}

export function approve(
  rec: ReviewRecord, report: VerificationReport, reviewer: { name: string; licenseNo: string }, at: string,
): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError(`cannot approve from state ${rec.state}`);
  if (!reviewer.name.trim() || !reviewer.licenseNo.trim()) throw new ReviewError("reviewer name and licence number are required");
  if (report.verdict === "fail") throw new ReviewError("cannot approve a failing document");
  if (report.coverage.status !== "complete") throw new ReviewError(`cannot approve with corpus coverage ${report.coverage.status}; resolve every required source first`);
  if (report.documentSha256 !== rec.verifiedSha256) throw new ReviewError("document changed since verification; verify again");
  if (report.corpusSnapshotId !== rec.verifiedCorpusSnapshotId) throw new ReviewError("corpus changed since verification; verify again");
  if (report.counts.unverifiedMarkers > 0) throw new ReviewError("document still contains unverified markers");
  return move(rec, "approved", `${reviewer.name} (${reviewer.licenseNo})`, at, {
    approvedSha256: report.documentSha256, approvedCorpusSnapshotId: report.corpusSnapshotId,
    reviewer: { name: reviewer.name.trim(), licenseNo: reviewer.licenseNo.trim() }, decidedAt: at,
  });
}

export function reject(rec: ReviewRecord, actor: string, note: string, at: string): ReviewRecord {
  if (rec.state !== "in_review") throw new ReviewError(`cannot reject from state ${rec.state}`);
  return move(rec, "rejected", actor, at, { note: note.slice(0, 500), decidedAt: at });
}

/** Any change to the text sends the record back to draft (approval does not survive edits). */
export function onContentChanged(rec: ReviewRecord, newSha256: string, actor: string, at: string): ReviewRecord {
  const anchor = rec.approvedSha256 ?? rec.verifiedSha256;
  if (!anchor || anchor === newSha256 || rec.state === "draft") return rec;
  return move(rec, "draft", actor, at, {
    verifiedSha256: undefined, approvedSha256: undefined,
    verifiedCorpusSnapshotId: undefined, approvedCorpusSnapshotId: undefined, reviewer: undefined,
  });
}

export function canExportFinal(rec: ReviewRecord, currentSha256: string): boolean {
  return rec.state === "approved" && rec.approvedSha256 === currentSha256;
}

export const DRAFT_WATERMARK_AR = "مسودة للمراجعة — لا تُقدَّم ولا تُرسَل قبل اعتماد محامٍ مرخّص في دولة قطر";
export const DISCLAIMER_AR = "هذه المخرجات أعدّها مساعد آلي لدعم العمل القانوني، وليست بديلاً عن رأي محامٍ مرخّص في دولة قطر، ولا تُعد استشارة قانونية.";
export const DISCLAIMER_EN = "Prepared by an AI assistant to support legal work. Not a substitute for a lawyer licensed in the State of Qatar; not legal advice.";
