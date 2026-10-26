import assert from "node:assert/strict";
import { test } from "node:test";
import { startMockServer, type MockServer } from "../../../scripts/legal-mock-server.js";
import { fillAvids } from "../../../legal/__tests__/helpers.js";

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
