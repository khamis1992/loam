import assert from "node:assert/strict";
import fs from "node:fs";
import { BackendSandbox } from "../agent/backendSandbox.js";
import { canonicalRows } from "../agent/sqliteChecks.js";
import { parseAppContract } from "../agent/appVerification.js";
import { runInstalledCase } from "./installed-bot-case.js";
const fill = (selector: string, value: string) => ({ action: "fill", selector, value });
const create = (id = "a", title = "الأولى") => [fill("#id", id), fill("#title", title), { action: "click", selector: "#create" }, { action: "count", selector: ".ticket", count: 1 }];
const edit = (version: string, title: string, status: string) => [fill("#editId", "a"), fill("#editTitle", title), fill("#editStatus", status), fill("#editVersion", version), { action: "click", selector: "#update" }];
const item = (title = "الأولى", status = "open", version = 1) => ({ id: "a", title, status, version });
const db = (title = "الأولى", status = "open", version = 1) => [{ database: "/tmp/tickets.sqlite", table: "tickets", columns: ["id", "title", "status", "version"], rows: [["a", title, status, version]] }];
const get = (expected: unknown) => ({ requests: [{ method: "GET", path: "/api/tickets", expectedJson: { items: [expected] } }], statuses: [200] });
const patch = (body: unknown) => ({ method: "PATCH", path: "/api/tickets/a", body: JSON.stringify(body) });
const exact = (selector: string, value: string) => ({ action: "textExact", selector, value });
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [
  { name: "Create and inspect JSON", steps: create(), apiChecks: [get(item())], sqliteChecks: db() },
  { name: "Update version", steps: [...create(), ...edit("1", "محدثة", "closed"), exact('.ticket[data-id="a"] [data-version]', "2"), exact('.ticket[data-id="a"] [data-title]', "محدثة")], apiChecks: [get(item("محدثة", "closed", 2))], sqliteChecks: db("محدثة", "closed", 2) },
  { name: "Reject stale edit", steps: [...create(), ...edit("1", "محدثة", "closed"), exact('.ticket[data-id="a"] [data-version]', "2"), ...edit("1", "قديمة", "open"), { action: "visible", selector: "#error" }, exact('.ticket[data-id="a"] [data-title]', "محدثة")], expectedResponses: [{ method: "PATCH", path: "/api/tickets/a", status: 409, count: 1 }], apiChecks: [get(item("محدثة", "closed", 2))], sqliteChecks: db("محدثة", "closed", 2) },
  { name: "Reload retains version", steps: [...create(), ...edit("1", "محدثة", "closed"), exact('.ticket[data-id="a"] [data-version]', "2"), { action: "reload" }, exact('.ticket[data-id="a"] [data-version]', "2")], apiChecks: [get(item("محدثة", "closed", 2))], sqliteChecks: db("محدثة", "closed", 2) },
  { name: "Concurrent updates have one winner", steps: create(), apiChecks: [
    { requests: [patch({ title: "متزامنة", status: "closed", version: 1 }), patch({ title: "متزامنة", status: "closed", version: 1 })], statuses: [200, 409] },
    get(item("متزامنة", "closed", 2)),
    { requests: [{ ...patch({ title: "قديمة", status: "open", version: 1 }), expectedJson: { error: "version_conflict" } }], statuses: [409] },
  ], sqliteChecks: db("متزامنة", "closed", 2) },
  { name: "Invalid API inputs leave state unchanged", steps: create(), apiChecks: [
    ...[{ title: " ", status: "open", version: 1 }, { title: "x", status: "bad", version: 1 }, { title: "x", status: "open", version: "1" }, { title: "x", status: "open", version: 1.5 }].map(body => ({ requests: [{ ...patch(body), expectedJson: { error: "invalid" } }], statuses: [400] })),
    { requests: [{ method: "PATCH", path: "/api/tickets/a", body: "{broken", expectedJson: { error: "invalid" } }], statuses: [400] },
    { requests: [{ method: "PATCH", path: "/api/tickets/missing", body: JSON.stringify({ title: "x", status: "open", version: 1 }), expectedJson: { error: "not_found" } }], statuses: [404] },
    get(item()),
  ], sqliteChecks: db() },
] };
const prompt = `أنشئ تطبيق إدارة تذاكر عربي RTL سماوي وبنفسجي متجاوب، يمنع ضياع التعديلات المتزامنة باستخدام رقم إصدار لكل سجل. ملفات index.html وserver.mjs وapp-verification.json في جذر المهمة. Node المدمج فقط، خادم 127.0.0.1:3000، SQLite حقيقي داخل الحاوية /tmp/tickets.sqlite وجدول tickets(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL)، يبدأ فارغًا.
API بعقود JSON دقيقة لا تضف حقولًا أخرى: GET /api/tickets يرجع {items:[{id,title,status,version}]} مرتبًا تصاعديًا حسب id. POST /api/tickets يقبل {id,title} ويُنشئ status=open وversion=1، ويرجع 201 {item:{id,title,status,version}}؛ المعرف مكوّن من 1–40 حرف ASCII أبجدي/رقمي أو _ أو -، والعنوان نص يحوي محارف غير بيضاء، خزّن title بعد trim. المعرف المكرر يرجع 409 {error:"duplicate"} دون تعديل السجل السابق.
PATCH /api/tickets/<id> يقبل {title,status,version}؛ title كما سبق، status إما open أو closed فقط، وversion عدد صحيح آمن موجب من نوع number. طلب غير صالح أو JSON معطوب يرجع 400 {error:"invalid"}. سجل غير موجود يرجع 404 {error:"not_found"}. إذا version لا يطابق الإصدار الحالي يرجع 409 {error:"version_conflict"} دون تغيير. عند التطابق حدّث العنوان والحالة وزد version بمقدار واحد وأعد 200 {item:{id,title,status,version}}. المقارنة والتحديث ذرّيان داخل معاملة مع استعلامات مربوطة؛ طلبان متزامنان بإصدار قديم نفسه يسمحان بتحديث واحد فقط.
واجهة إنشاء #id و#title وزر #create، وواجهة تعديل بحقول نص عادية #editId و#editTitle و#editStatus و#editVersion وزر #update. حوّل رقم الإصدار الصحيح إلى number قبل الإرسال. لكل سجل صف .ticket[data-id="a"] بحسب المعرف وداخله [data-title] و[data-status] و[data-version]، الأخير يعرض العدد فقط. لا تكتب فوق حقول التعديل تلقائيًا أثناء تعبئتها، حتى نختبر تقديم إصدار قديم صراحة. اعرض رسالة عربية #error عند التعارض أو الخطأ وتختفي بعد النجاح، وحدّث الجدول من الخادم عند التحميل وبعد كل طلب. لا تستخدم localStorage أو ذاكرة بديلة أو مكتبات خارجية أو نوافذ تأكيد.
احفظ عقد الاختبار التالي دون تغيير: ${JSON.stringify(contract)}.
استخدم أدوات الملفات فقط ولا تشغّل الخادم على Windows. المنظومة تختبر المتصفح والصور وطلبات API ومحتوى expectedJson الدقيق وقاعدة البيانات داخل Docker. لا تدع دوام البيانات بعد حذف الحاوية.`;
async function probe(workspace: string) {
  const sandbox = await BackendSandbox.start(workspace, "server.mjs");
  try {
    const request = async (method: string, route: string, body?: unknown) => {
      const response = await sandbox.request(route, method, { "content-type": "application/json" }, body === undefined ? "" : Buffer.from(JSON.stringify(body)).toString("base64"));
      return { status: response.status, json: JSON.parse(Buffer.from(response.body, "base64").toString("utf8")) };
    };
    assert.deepEqual(await request("POST", "/api/tickets", { id: "a", title: "  first  " }), { status: 201, json: { item: { id: "a", title: "first", status: "open", version: 1 } } });
    assert.deepEqual(await request("POST", "/api/tickets", { id: "a", title: "overwrite" }), { status: 409, json: { error: "duplicate" } });
    const competing = await Promise.all(["left", "right"].map(title => request("PATCH", "/api/tickets/a", { title, status: "closed", version: 1 })));
    assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
    const winner = competing.find(r => r.status === 200)!.json.item;
    assert.ok(["left", "right"].includes(winner.title));
    assert.deepEqual(winner, { id: "a", title: winner.title, status: "closed", version: 2 });
    assert.deepEqual(competing.find(r => r.status === 409)!.json, { error: "version_conflict" });
    assert.deepEqual(await request("GET", "/api/tickets"), { status: 200, json: { items: [winner] } });
    for (const version of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(await request("PATCH", "/api/tickets/a", { title: "bad", status: "open", version }), { status: 400, json: { error: "invalid" } });
    assert.deepEqual(await request("PATCH", "/api/tickets/a", { title: "stale", status: "open", version: 1 }), { status: 409, json: { error: "version_conflict" } });
    assert.deepEqual(await request("PATCH", "/api/tickets/a", { title: "final", status: "open", version: 2 }), { status: 200, json: { item: { id: "a", title: "final", status: "open", version: 3 } } });
    const rows = await sandbox.readSqlite({ database: "/tmp/tickets.sqlite", table: "tickets", columns: ["id", "title", "status", "version"], rows: [] });
    assert.equal(canonicalRows(rows), canonicalRows([["a", "final", "open", 3]]));
    return { pass: true, competing, rows, scope: "one ephemeral sandbox" };
  } finally { await sandbox.close(); }
}
if (process.argv.includes("--dry-run")) {
  parseAppContract(JSON.stringify(contract));
  fs.writeFileSync("docs/evidence/bot-tickets-test-spec.json", JSON.stringify({ prompt, contract, status: "prepared, not executed" }, null, 2));
  console.log("PASS ticket concurrency and exact JSON specification parses");
} else {
  const observeTaskId = process.argv.find(arg => arg.startsWith("--observe-task="))?.slice("--observe-task=".length);
  await runInstalledCase({ title: "اختبار BOT — تذاكر وتعديلات متزامنة", prompt, contract, ...(observeTaskId ? { observeTaskId } : {}), output: observeTaskId ? "docs/evidence/bot-installed-tickets-recovered-live.json" : "docs/evidence/bot-installed-tickets-live.json", probe });
}
