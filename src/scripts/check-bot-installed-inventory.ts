/** Real installed BOT generation, browser/vision, then independent SQLite probe. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { probeInventoryDatabase } from "./inventory-database-probe.js";
const base = "http://127.0.0.1:3939";
const output = process.argv.find(a => a.startsWith("--output="))?.slice(9) || "docs/evidence/bot-installed-inventory-live.json";
const sqliteChecks = process.argv.includes("--sqlite-checks");
const fill = (selector: string, value: string) => ({ action: "fill", selector, value });
const click = (selector: string) => ({ action: "click", selector });
const count = (n: number) => ({ action: "count", selector: ".stock-item", count: n });
const qty = (value: string) => ({ action: "textExact", selector: ".stock-item [data-quantity]", value });
const add = (sku: string, quantity: string) => [fill("#sku", sku), fill("#quantity", quantity), click("#save")];
const withdraw = (quantity: string) => [fill("#withdraw-sku", "كتاب"), fill("#withdraw-quantity", quantity), click("#withdraw")];
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [
  { name: "Add stock", steps: [...add("كتاب", "10"), count(1), qty("10")] },
  { name: "Server persistence on reload", steps: [...add("كتاب", "10"), { action: "reload" }, count(1), qty("10")] },
  { name: "Valid withdrawal", steps: [...add("كتاب", "10"), qty("10"), ...withdraw("3"), qty("7")] },
  { name: "Overdraw rejected without changing stock", expectedResponses: [{ method: "POST", path: "/api/withdraw", status: 409, count: 1 }], steps: [...add("كتاب", "10"), qty("10"), ...withdraw("11"), { action: "visible", selector: "#error" }, qty("10")] },
  { name: "Duplicate SKU rejected", expectedResponses: [{ method: "POST", path: "/api/stock", status: 409, count: 1 }], steps: [...add("كتاب", "10"), qty("10"), ...add("كتاب", "99"), { action: "visible", selector: "#error" }, count(1), qty("10")] },
  { name: "Negative amount rejected", steps: [...add("كتاب", "-1"), { action: "visible", selector: "#error" }, count(0)] },
] };
if (sqliteChecks) {
  for (const [index, scenario] of contract.scenarios.entries()) Object.assign(scenario, { sqliteChecks: [{ database: "/tmp/inventory.sqlite", table: "stock", columns: ["sku", "quantity"], rows: index === 5 ? [] : [["كتاب", index === 2 ? 7 : 10]] }] });
}
const prompt = `أنشئ تطبيق مخزون عربي RTL بتصميم سماوي وبنفسجي متجاوب: index.html وserver.mjs، دون مكتبات خارجية. احفظ ملفات المصدر والعقد في جذر مساحة عمل المهمة بمسارات نسبية للأدوات؛ لا تنشئ مجلد مشروع آخر. خادم Node على 127.0.0.1:3000 باستخدام node:http وnode:sqlite. قاعدة SQLite فعلية في /tmp/inventory.sqlite داخل حاوية Docker فقط، وجدول stock(sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity>=0)). لا تستخدم مصفوفة ذاكرة أو localStorage بدل القاعدة. تبدأ القاعدة بلا أصناف. قيد الكتابة في /tmp يخص بيانات الخادم أثناء تشغيله داخل الحاوية؛ لا يخص مسارات إنشاء ملفات المصدر على جهاز المستخدم.
API ثابت: GET /api/stock يعيد {items:[{sku,quantity}]}؛ POST /api/stock يستقبل JSON {sku,quantity} وينشئ صنفًا برصيد صحيح موجب ويرجع 201، ويعيد 409 إذا تكرر الرمز؛ POST /api/withdraw يستقبل {sku,quantity} ويسحب كمية صحيحة موجبة ويرجع 200، ويعيد 409 إذا لم يوجد الصنف أو لم يكف الرصيد دون تغيير البيانات. الإدخال غير الصالح يعيد 400. استخدم معاملات وSQL بمعاملات ربط، ولا تدمج الرمز داخل SQL.
الواجهة: حقلا #sku و#quantity وزر #save للإضافة؛ #withdraw-sku و#withdraw-quantity وزر #withdraw للسحب؛ رسالة خطأ عربية #error ظاهرة عند رفض العملية، وجدول #items كل صف بيانات فيه .stock-item وخلية الرصيد تحمل data-quantity وتعرض الرقم وحده. تستدعي الواجهة API وتعرض البيانات من الخادم بعد كل عملية وعند تحميل الصفحة. لا تترك ردود fetch بلا معالجة. أظهر أخطاء الإدخال حتى عند العدد السالب (لا تعتمد على منع HTML وحده الذي لا يُظهر #error). لا تستخدم نافذة تأكيد تعطل الاختبار.
احفظ app-verification.json بهذا العقد بالضبط: ${JSON.stringify(contract)}.
استخدم أدوات الملفات فقط، ولا تشغل الخادم على Windows؛ النظام سيشغله داخل Docker المعزول. الهدف تطبيق يعمل وتتحقق منه المنظومة، لا إجابة نصية. لا تدّع دوام البيانات بعد حذف الحاوية؛ التخزين هنا يبقى خلال سيناريو الاختبار فقط.`;
const capabilities = await (await fetch(`${base}/api/bot/capabilities`)).json() as { revision: number };
assert.ok(capabilities.revision >= (sqliteChecks ? 7 : 6));
const started = Date.now();
const events: Array<Record<string, unknown>> = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), capabilities, request: prompt, events, pass: false };
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ...evidence, elapsedMs: Date.now() - started }, null, 2)); };
save();
try {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, title: "اختبار BOT — مخزون SQLite", mode: "build", workMode: "loam", model: "glm-5.3-flash:cloud" }), signal: AbortSignal.timeout(1_200_000) });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const line = block.split("\n").find(l => l.startsWith("data: ")); if (!line) continue;
      const e = JSON.parse(line.slice(6)); events.push(e);
      if (["task", "plan", "verify", "revise", "error", "done"].includes(e.type)) { console.log(JSON.stringify(e)); save(); }
    }
  }
  const taskId = String(events.find(e => e.type === "task")?.taskId ?? "");
  const details = await (await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`)).json() as { task: { status: string; workspace: string } };
  Object.assign(evidence, { taskId, task: details.task }); save();
  assert.equal(details.task.status, "done");
  const verified = events.findIndex(e => e.type === "verify" && e.verdict === "pass");
  assert.ok(verified >= 0 && events.findIndex(e => e.type === "done") > verified);
  assert.ok(events.findIndex(e => e.type === "assistant_message") > verified);
  assert.ok(events.filter(e => e.type === "tool_call").every(e => ["file_write", "file_read", "file_edit", "file_stat", "file_list", "file_search", "file_mkdir", "file_view_image"].includes(String(e.name))));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(details.task.workspace, "app-verification.json"), "utf8")), contract);
  const event = events.find(e => e.type === "tool_result" && e.name === "application_verification" && e.ok);
  const reportPath = String(event?.summary).match(/\nReport: (.+)$/)?.[1]?.trim(); assert.ok(reportPath);
  const relative = path.relative(path.join(details.task.workspace, ".verification"), path.resolve(reportPath));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.ok(report.pass && report.checks.length === 12 && report.checks.every((c: { pass: boolean }) => c.pass) && report.visual?.verdict?.verdict === "pass");
  if (sqliteChecks) for (const [index, check] of report.checks.entries()) {
    assert.equal(check.databases?.length, 1, "production report must contain actual independent database evidence");
    assert.deepEqual(check.databases[0].rows, index % 6 === 5 ? [] : [["كتاب", index % 6 === 2 ? 7 : 10]]);
  }
  evidence.report = report;
  evidence.independentDatabaseProbe = await probeInventoryDatabase(details.task.workspace);
  evidence.pass = true;
  console.log("PASS installed BOT: real generated SQLite inventory, desktop/mobile/vision and independent read-only database probe");
} catch (error) {
  evidence.error = String(error); process.exitCode = 1;
  console.error(String(error));
} finally { save(); }
