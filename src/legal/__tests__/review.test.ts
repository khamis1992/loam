import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStructure, coverSheetAr, internalLeaks } from "../memo.js";
import { acceptReviewWarning, addReviewComment, approve, canExportFinal, markVerified, newReview, onContentChanged, reject, ReviewError, submitForReview, DISCLAIMER_AR } from "../review.js";
import { reviewParagraphs } from "../review/paragraphs.js";
import { buildReviewPackage } from "../review/reviewPackage.js";
import type { Matter, VerificationReport } from "../types.js";

const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({
  verdict: "pass", asOf: "2092-01-01", checks: [], warnings: [], documentSha256: "a".repeat(64),
  corpusSnapshotId: "CS-test", coverage: { status: "complete", matterKind: "research", asOf: "2092-01-01", entries: 0, issues: [], checkedAt: "2092-01-01T00:00:00Z" },
  counts: { cited: 1, verified: 1, failed: 0, freeMentions: 0, unverifiedMarkers: 0 }, ...over,
});
const at = "2092-01-01T08:00:00.000Z";

test("happy path: draft -> verified -> in_review -> approved, export final only for the same text", () => {
  let r = newReview("mt-1", "مذكرة.md");
  r = markVerified(r, report(), "agent", at);
  r = submitForReview(r, "user", at);
  r = approve(r, report(), { name: "المحامي المختبر", licenseNo: "QA-0000" }, at);
  assert.equal(r.state, "approved");
  assert.equal(canExportFinal(r, "a".repeat(64)), true);
  assert.equal(canExportFinal(r, "b".repeat(64)), false);
  assert.equal(r.history.length, 3);
});

test("the gate refuses failing reports, missing licence, changed text and open markers", () => {
  assert.throws(() => markVerified(newReview("m", "d"), report({ verdict: "fail" }), "agent", at), ReviewError);
  const inReview = submitForReview(markVerified(newReview("m", "d"), report(), "agent", at), "user", at);
  assert.throws(() => approve(inReview, report(), { name: "x", licenseNo: " " }, at), /licence/);
  assert.throws(() => approve(inReview, report({ documentSha256: "c".repeat(64) }), { name: "x", licenseNo: "1" }, at), /changed/);
  assert.throws(() => approve(inReview, report({ counts: { cited: 1, verified: 1, failed: 0, freeMentions: 0, unverifiedMarkers: 2 } }), { name: "x", licenseNo: "1" }, at), /unverified/);
  assert.throws(() => submitForReview(newReview("m", "d"), "user", at), /cannot submit/);
  assert.equal(reject(inReview, "user", "أعد صياغة الطلبات", at).state, "rejected");
});

test("any edit after approval sends the document back to draft", () => {
  let r = approve(submitForReview(markVerified(newReview("m", "d"), report(), "agent", at), "user", at), report(), { name: "x", licenseNo: "1" }, at);
  r = onContentChanged(r, "d".repeat(64), "agent", at);
  assert.equal(r.state, "draft");
  assert.equal(r.approvedSha256, undefined);
  assert.equal(canExportFinal(r, "d".repeat(64)), false);
});

const MEMO = `## بيانات الدعوى
المحكمة الابتدائية — الدائرة المدنية — الدعوى رقم 1/2092
## الوقائع
وقائع.
## الدفاع الموضوعي
دفاع.
## الطلبات
أصلياً: رفض الدعوى.`;

test("defense memo structure: required sections, order, and no internal notes", () => {
  assert.deepEqual(checkStructure("defense_memo", MEMO), []);
  const missing = checkStructure("defense_memo", MEMO.replace("## الطلبات", "## خاتمة"));
  assert.ok(missing.some((i) => i.code === "MISSING_REQUESTS" && i.level === "error"));
  const swapped = `## الوقائع\nx\n## بيانات الدعوى\nx\n## الدفاع الموضوعي\nx\n## الطلبات\nx`;
  assert.ok(checkStructure("defense_memo", swapped).some((i) => i.code === "ORDER"));
  assert.ok(checkStructure("defense_memo", `${MEMO}\nأعدّ هذا النص مساعد آلي.`).some((i) => i.code === "INTERNAL_NOTE_IN_COURT_TEXT"));
});

test("opinion requires the caveats section with the disclaimer", () => {
  const base = ["الخلاصة التنفيذية", "الوقائع", "المسألة القانونية", "الإطار القانوني", "التحليل", "التوصية"].map((h) => `## ${h}\nنص.`).join("\n");
  assert.ok(checkStructure("opinion", base).some((i) => i.code === "MISSING_CAVEATS"));
  assert.ok(checkStructure("opinion", `${base}\n## التحفظات\nلا شيء.`).some((i) => i.code === "DISCLAIMER"));
  assert.deepEqual(checkStructure("opinion", `${base}\n## التحفظات\n${DISCLAIMER_AR}`), []);
});

test("rendered documents must not leak tokens, ids, paths, hashes or tool names", () => {
  assert.equal(internalLeaks("المادة (3) من القانون المدني").length, 0);
  const leaks = internalLeaks(`انظر QL-0123456789 و C:\\Users\\x و legal_search و ${"f".repeat(64)}`).map((l) => l.messageAr);
  assert.equal(leaks.length, 4);
});

test("cover sheet carries status, verification and the disclaimer", () => {
  const matter: Matter = { id: "mt-1", title: "دعوى اختبار", kind: "defense_memo", confidentiality: "privileged", egress: "local_only", asOf: "2092-01-01", parties: [], createdAt: at, updatedAt: at, retainUntil: null };
  const sheet = coverSheetAr(matter, "مذكرة.md", report({ verdict: "pass_with_warnings", warnings: [{ code: "AMENDED_AFTER_DATE", messageAr: "عُدّل النص لاحقاً", messageEn: "" }] }), undefined);
  assert.match(sheet, /ورقة غلاف داخلية/u);
  assert.match(sheet, /عُدّل النص لاحقاً/u);
  assert.ok(sheet.includes(DISCLAIMER_AR));
  assert.match(sheet, /privileged/);
});

test("lawyer comments, warning decisions and the internal review package stay version-bound", () => {
  const verification = report({ verdict: "pass_with_warnings", warnings: [{ code: "AMENDED_AFTER_DATE", messageAr: "عُدّل النص لاحقاً", messageEn: "" }] });
  let review = submitForReview(markVerified(newReview("mt-1", "memo.docx"), verification, "agent", at), "user", at);
  const paragraph = reviewParagraphs("الفقرة الأولى\nالفقرة الثانية")[0]!;
  review = addReviewComment(review, { ...paragraph, body: "راجع هذا الموضع" }, { name: "مراجع", licenseNo: "QA-1" }, at);
  review = acceptReviewWarning(review, { code: "AMENDED_AFTER_DATE", reason: "راجعت التعديل اللاحق" }, { name: "مراجع", licenseNo: "QA-1" }, at);
  assert.equal(review.comments[0]?.anchor.quote, "الفقرة الأولى");
  assert.deepEqual(review.decisions.map((decision) => decision.action), ["comment", "accept_warning"]);
  assert.throws(() => addReviewComment(review, { ...paragraph, body: " " }, { name: "مراجع", licenseNo: "QA-1" }, at), ReviewError);
  assert.throws(() => acceptReviewWarning(review, { code: "UNKNOWN", reason: "غير موجود" }, { name: "مراجع", licenseNo: "QA-1" }, at), /not present/);
  const matter: Matter = { id: "mt-1", title: "دعوى", kind: "defense_memo", confidentiality: "privileged", egress: "local_only", asOf: "2092-01-01", parties: [], createdAt: at, updatedAt: at, retainUntil: null };
  const bundle = JSON.parse(buildReviewPackage(matter, review, undefined, at)) as { internal: boolean; watermark: string; review: typeof review; verification: unknown };
  assert.equal(bundle.internal, true);
  assert.match(bundle.watermark, /مسودة للمراجعة/);
  assert.equal(bundle.review.comments.length, 1);
  assert.deepEqual(bundle.verification, verification);
});
