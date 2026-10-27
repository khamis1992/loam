import assert from "node:assert/strict";
import { test } from "node:test";
import { startMockServer, type MockServer } from "../../../scripts/legal-mock-server.js";
import { fillAvids } from "../../../legal/__tests__/helpers.js";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";

async function call(srv: MockServer, method: string, p: string, body?: unknown, token = srv.token): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${srv.url}${p}`, {
    method, headers: { "x-loam-local-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("mock server: token, status, search, verify, matters, egress, review gate, audit", async () => {
  const srv = await startMockServer(0, "t0k", () => new Date("2092-01-10T08:00:00Z"));
  try {
    assert.equal((await call(srv, "GET", "/api/legal/status", undefined, "wrong")).status, 401);
    const st = await call(srv, "GET", "/api/legal/status");
    assert.equal(st.status, 200);
    assert.equal(st.json.today, "2092-01-10");
    assert.equal(st.json.localModelApproved, true);
    assert.equal(st.json.keyAvailable, true);
    const preflight = await fetch(`${srv.url}/api/legal/status`, { method: "OPTIONS", headers: { origin: "app://agent", "x-loam-local-token": srv.token } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "app://agent");
    const desktopStatus = await fetch(`${srv.url}/api/legal/status`, { headers: { origin: "app://agent", "x-loam-local-token": srv.token } });
    assert.equal(desktopStatus.headers.get("access-control-allow-origin"), "app://agent");

    const s = await call(srv, "GET", `/api/legal/search?q=${encodeURIComponent("المادة 3 من القانون المدني الاختباري")}&asOf=2091-01-01`);
    assert.equal(((s.json.hits as Array<{ effectiveFrom: string }>)[0])?.effectiveFrom, "2090-04-01");
    assert.equal((await call(srv, "GET", "/api/legal/search")).status, 400);
    assert.equal((await call(srv, "GET", "/api/legal/laws/law/2090/1")).status, 200);
    assert.equal((await call(srv, "GET", "/api/legal/laws/law/2090/99")).status, 404);

    const created = await call(srv, "POST", "/api/legal/matters", { title: "دعوى اختبار", kind: "defense_memo", asOf: "2092-01-01" });
    assert.equal(created.status, 201);
    const matter = created.json.matter as { id: string; egress: string };
    assert.equal(matter.egress, "local_only");
    srv.ctx.corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
    srv.ctx.corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["defense_memo"] }]);
    assert.equal((await call(srv, "PATCH", `/api/legal/matters/${matter.id}`, { egress: "cloud_full" })).status, 400, "confirmation required");
    const widened = await call(srv, "PATCH", `/api/legal/matters/${matter.id}`, { egress: "cloud_redacted", confirmEgress: true });
    assert.equal((widened.json.matter as { egress: string }).egress, "cloud_redacted");

    const citation = fillAvids("«يجب تنفيذ العقد طبقاً لما اشتمل عليه وبطريقة تتفق مع ما يوجبه حسن النية.» ⟦cite:{{law/2090/1:body:4@2090-04-01}}⟧");
    const text = `## بيانات الدعوى\nالدائرة المدنية — الدعوى 1/2092\n## الوقائع\nوقائع اختبارية موثقة.\n## الدفاع الموضوعي\n${citation}\n## الطلبات\nأصلياً: طلب اختباري محدد.`;
    const v = await call(srv, "POST", "/api/legal/verify", { text, matterId: matter.id, documentName: "memo.md" });
    assert.equal((v.json.report as { verdict: string }).verdict, "pass");
    assert.match(String(v.json.coverSheet), /ورقة غلاف داخلية/u);
    const fab = await call(srv, "POST", "/api/legal/verify", { text: "«نص مختلق لا وجود له في أي قانون اختباري» ⟦cite:QL-ffffffffff⟧" });
    assert.equal((fab.json.report as { verdict: string }).verdict, "fail");

    // review gate through the store (as the cite-check tool would), then HTTP transitions
    const { newReview, markVerified } = await import("../../../legal/review.js");
    const { verifyDocument } = await import("../../../legal/verify.js");
    const rep = verifyDocument(srv.ctx.corpus, text, { asOf: "2092-01-01" });
    const rec = markVerified(newReview(matter.id, "memo.md"), rep, "agent", "2092-01-10T08:00:00Z");
    srv.ctx.matters.saveReview(rec);
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${rec.id}/approve`, { text, reviewerName: "x", licenseNo: "1" })).status, 409, "must be submitted first");
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${rec.id}/submit`, {})).status, 200);
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${rec.id}/approve`, { text: `${text} تعديل`, reviewerName: "x", licenseNo: "1" })).status, 409, "changed text");
    const ok = await call(srv, "POST", `/api/legal/reviews/${rec.id}/approve`, { text, reviewerName: "المحامي المختبر", licenseNo: "QA-0000" });
    assert.equal((ok.json.review as { state: string }).state, "approved");

    const audit = await call(srv, "GET", `/api/legal/audit?matterId=${matter.id}`);
    assert.ok((audit.json.events as unknown[]).length >= 3);
    assert.equal((await call(srv, "GET", "/api/legal/audit/verify")).json.intact, true);
    assert.equal((await call(srv, "DELETE", `/api/legal/matters/${matter.id}`)).json.deleted, true);
    assert.equal((await call(srv, "GET", `/api/legal/matters/${matter.id}`)).status, 404);
  } finally {
    await srv.close();
  }
});

test("matter document upload builds an evidence workspace", async () => {
  const srv = await startMockServer(0, "t");
  try {
    const created = await call(srv, "POST", "/api/legal/matters", { title: "ملف قضية", kind: "defense_memo", asOf: "2024-01-15" });
    const matter = created.json.matter as { id: string };
    const uploaded = await call(srv, "POST", `/api/legal/matters/${matter.id}/documents`, {
      fileName: "evidence.txt", dataBase64: Buffer.from("المبلغ 1000 ريال بتاريخ 2024/01/15.", "utf8").toString("base64"),
    });
    assert.equal(uploaded.status, 201);
    assert.equal((uploaded.json.document as { text: string }).text.includes("1000"), true);
    assert.ok(String(uploaded.json.vaultId).startsWith("file-"));
    const workspace = await call(srv, "GET", `/api/legal/matters/${matter.id}/documents`);
    assert.equal((workspace.json.facts as unknown[]).length, 1);
    assert.equal((workspace.json.timeline as Array<{ sortDate: string }>)[0]?.sortDate, "2024-01-15");
    assert.equal((workspace.json.documents as Array<{ id: string }>).length, 1);
  } finally {
    await srv.close();
  }
});

test("import draft + import: refuses unsigned official packs, accepts a signed one", async () => {
  const srv = await startMockServer(0, "t");
  try {
    const raw = "المادة 1\nتسري أحكام هذا القانون الاختباري على جميع العقود الإلكترونية.\nالمادة 2\nيُعمل به من تاريخ نشره.";
    const legislation = { type: "law", year: 2096, number: 1, titleAr: "قانون اختباري رقم (1) لسنة 2096 بشأن العقود الإلكترونية", effectiveDate: "2096-01-01" };
    const source = { provenance: "official_gazette", retrievedAt: "2096-01-02" };
    const d = await call(srv, "POST", "/api/legal/import/draft", { legislation, source, rawText: raw });
    assert.ok((d.json.errors as string[]).some((e) => e.includes("verifiedBy")));
    const pack = d.json.pack as Record<string, unknown>;
    assert.equal((await call(srv, "POST", "/api/legal/import", { pack })).status, 422);
    const signed = { ...pack, source: { ...source, verifiedBy: "مراجع" } };
    const imp = await call(srv, "POST", "/api/legal/import", { pack: signed });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.articles, 2);
  } finally {
    await srv.close();
  }
});

test("original DOCX redline is produced through the API", async () => {
  const srv = await startMockServer(0, "t");
  try {
    const matter = (await call(srv, "POST", "/api/legal/matters", { title: "عقد", kind: "contract_review" })).json.matter as { id: string };
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("البند 1\nالثمن 1000 ريال")] }] }));
    const added = await call(srv, "POST", `/api/legal/matters/${matter.id}/contracts`, { fileName: "contract.docx", text: "البند 1\nالثمن 1000 ريال", originalBase64: original.toString("base64") });
    const contract = added.json.contract as { id: string };
    const clause = srv.ctx.matters.clauses(contract.id)[0]!;
    const redline = await call(srv, "POST", `/api/legal/matters/${matter.id}/contracts/${contract.id}/redline`, { edits: [{ clauseId: clause.id, newText: clause.text.replace("1000", "2000") }] });
    assert.equal(redline.status, 200);
    const zip = await JSZip.loadAsync(Buffer.from(String(redline.json.dataBase64), "base64"));
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.match(xml, /2000/);
    assert.match(xml, /w:ins/);
  } finally {
    await srv.close();
  }
});

test("DOCX artifact verification, lawyer approval and exact-byte export are fail closed", async () => {
  const srv = await startMockServer(0, "t", () => new Date("2092-01-10T08:00:00Z"));
  try {
    srv.ctx.corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
    srv.ctx.corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["contract_review"] }]);
    const matter = (await call(srv, "POST", "/api/legal/matters", { title: "اعتماد عقد", kind: "contract_review", asOf: "2092-01-01" })).json.matter as { id: string };
    const citation = fillAvids("«يجب تنفيذ العقد طبقاً لما اشتمل عليه وبطريقة تتفق مع ما يوجبه حسن النية.» ⟦cite:{{law/2090/1:body:4@2090-04-01}}⟧");
    const clauseText = `البند 1\nيلتزم الطرفان بحسن النية. ${citation}`;
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(clauseText)] }] }));
    const added = await call(srv, "POST", `/api/legal/matters/${matter.id}/contracts`, { fileName: "contract.docx", originalBase64: original.toString("base64") });
    assert.equal(added.status, 201);
    const contract = added.json.contract as { id: string };
    const clause = srv.ctx.matters.clauses(contract.id)[0]!;
    const redline = await call(srv, "POST", `/api/legal/matters/${matter.id}/contracts/${contract.id}/redline`, { edits: [{ clauseId: clause.id, newText: clause.text.replace("يلتزم", "يتعين على") }] });
    const dataBase64 = String(redline.json.dataBase64);
    const bytes = Buffer.from(dataBase64, "base64");
    const documentName = `redline-${contract.id}.docx`;

    const exportBeforeApproval = await call(srv, "GET", "/api/legal/reviews/rv-missing/export");
    assert.equal(exportBeforeApproval.status, 404);
    const verified = await call(srv, "POST", "/api/legal/artifacts/verify", { matterId: matter.id, documentName, dataBase64 });
    assert.equal(verified.status, 200);
    assert.equal((verified.json.report as { verdict: string }).verdict, "pass");
    const review = verified.json.review as { id: string; state: string };
    assert.equal(review.state, "verified");
    assert.equal((await call(srv, "GET", `/api/legal/reviews/${review.id}/export`)).status, 409);
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${review.id}/submit`, {})).status, 200);
    const paragraph = (verified.json.paragraphs as Array<{ start: number; end: number; quote: string }>)[0]!;
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${review.id}/comments`, { anchor: { ...paragraph, quote: "غير مطابق" }, body: "ملاحظة", reviewerName: "مراجع", licenseNo: "QA-1" })).status, 409);
    const commented = await call(srv, "POST", `/api/legal/reviews/${review.id}/comments`, { anchor: paragraph, body: "راجع هذا الموضع", reviewerName: "مراجع", licenseNo: "QA-1" });
    assert.equal(commented.status, 200);
    assert.equal((commented.json.review as { comments: unknown[]; decisions: unknown[] }).comments.length, 1);
    assert.equal((commented.json.review as { decisions: unknown[] }).decisions.length, 1);
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${review.id}/accept-warning`, { code: "UNKNOWN", reason: "غير موجود", reviewerName: "مراجع", licenseNo: "QA-1" })).status, 409);

    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${review.id}/approve-artifact`, { dataBase64: changed.toString("base64"), reviewerName: "مراجع", licenseNo: "QA-1" })).status, 409);
    const version = srv.ctx.corpus.db.prepare("SELECT avid, text_sha256 FROM article_versions LIMIT 1").get() as { avid: string; text_sha256: string };
    srv.ctx.corpus.db.prepare("UPDATE article_versions SET text_sha256=? WHERE avid=?").run("0".repeat(64), version.avid);
    assert.equal((await call(srv, "POST", `/api/legal/reviews/${review.id}/approve-artifact`, { dataBase64, reviewerName: "مراجع", licenseNo: "QA-1" })).status, 409, "a changed corpus snapshot must be verified again");
    srv.ctx.corpus.db.prepare("UPDATE article_versions SET text_sha256=? WHERE avid=?").run(version.text_sha256, version.avid);

    const approved = await call(srv, "POST", `/api/legal/reviews/${review.id}/approve-artifact`, { dataBase64, reviewerName: "مراجع", licenseNo: "QA-1" });
    assert.equal(approved.status, 200);
    assert.equal((approved.json.review as { state: string }).state, "approved");
    const artifact = approved.json.artifact as { id: string; artifactSha256: string; dataBase64: string };
    const exported = await call(srv, "GET", `/api/legal/reviews/${review.id}/export`);
    assert.equal(exported.status, 200);
    assert.notEqual(exported.json.dataBase64, dataBase64);
    assert.equal(exported.json.dataBase64, artifact.dataBase64);
    const finalZip = await JSZip.loadAsync(Buffer.from(artifact.dataBase64, "base64"));
    assert.equal(finalZip.file("word/headerLegalDraft.xml"), null);
    assert.match(await finalZip.file("word/document.xml")!.async("string"), /w:ins/);
    const reviewPackage = await call(srv, "GET", `/api/legal/reviews/${review.id}/review-package`);
    assert.equal(reviewPackage.status, 200);
    const bundle = JSON.parse(Buffer.from(String(reviewPackage.json.dataBase64), "base64").toString("utf8")) as { internal: boolean; review: { comments: unknown[]; decisions: unknown[] }; artifact: { dataBase64?: string } };
    assert.equal(bundle.internal, true);
    assert.equal(bundle.review.comments.length, 1);
    assert.equal(bundle.review.decisions.length, 2);
    assert.equal(bundle.artifact.dataBase64, undefined);

    const { FieldCipher } = await import("../../../legal/crypto.js");
    const cipher = new FieldCipher(srv.ctx.keys);
    srv.ctx.matters.db.prepare("UPDATE approval_artifacts SET data_enc=? WHERE id=?").run(cipher.seal(changed.toString("base64"), `approval-artifact:${artifact.id}`), artifact.id);
    assert.equal((await call(srv, "GET", `/api/legal/reviews/${review.id}/export`)).status, 409, "stored bytes must be hashed again at export");

    const badDocx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("«نص مختلق» ⟦cite:QL-ffffffffff⟧")] }] }));
    const bad = await call(srv, "POST", "/api/legal/artifacts/verify", { matterId: matter.id, documentName: "redline-invalid.docx", dataBase64: badDocx.toString("base64") });
    assert.equal((bad.json.report as { verdict: string }).verdict, "fail");
    assert.equal((bad.json.review as { state: string }).state, "draft");
    assert.equal((await call(srv, "POST", "/api/legal/artifacts/verify", { matterId: matter.id, documentName: "redline-broken.docx", dataBase64: Buffer.from("not a docx").toString("base64") })).status, 400);
  } finally {
    await srv.close();
  }
});
