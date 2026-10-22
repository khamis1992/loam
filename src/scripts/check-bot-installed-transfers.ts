import assert from "node:assert/strict";
import fs from "node:fs";
import { BackendSandbox } from "../agent/backendSandbox.js";
import { canonicalRows } from "../agent/sqliteChecks.js";
import { parseAppContract } from "../agent/appVerification.js";
import { runInstalledCase } from "./installed-bot-case.js";
const fill = (selector: string, value: string) => ({ action: "fill", selector, value });
const transfer = (id: string, from: string, to: string, quantity: string) => [fill("#requestId", id), fill("#from", from), fill("#to", to), fill("#quantity", quantity), { action: "click", selector: "#transfer" }];
const stock = (name: string, quantity: number) => ({ action: "textExact", selector: `.stock[data-warehouse="${name}"] [data-quantity]`, value: String(quantity) });
const count = (n: number) => ({ action: "count", selector: ".transfer", count: n });
const databases = (a: number, b: number, rows: (string | number)[][]) => [
  { database: "/tmp/transfers.sqlite", table: "stock", columns: ["warehouse", "quantity"], rows: [["A", a], ["B", b], ["C", 0]] },
  { database: "/tmp/transfers.sqlite", table: "transfers", columns: ["requestId", "source", "destination", "quantity"], rows },
];
const once = ["one", "A", "B", 3];
const conflict = [{ method: "POST", path: "/api/transfers", status: 409, count: 1 }];
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [
  { name: "Atomic transfer", steps: [...transfer("one", "A", "B", "3"), stock("A", 7), stock("B", 3), count(1)], sqliteChecks: databases(7, 3, [once]) },
  { name: "Idempotent replay", steps: [...transfer("one", "A", "B", "3"), count(1), ...transfer("one", "A", "B", "3"), stock("A", 7), stock("B", 3), count(1)], sqliteChecks: databases(7, 3, [once]) },
  { name: "Conflicting request id", steps: [...transfer("one", "A", "B", "3"), count(1), ...transfer("one", "A", "B", "4"), { action: "visible", selector: "#error" }, stock("A", 7), count(1)], expectedResponses: conflict, sqliteChecks: databases(7, 3, [once]) },
  { name: "Insufficient stock rollback", steps: [...transfer("large", "A", "B", "11"), { action: "visible", selector: "#error" }, stock("A", 10), stock("B", 0), count(0)], expectedResponses: conflict, sqliteChecks: databases(10, 0, []) },
  { name: "Reject same warehouse", steps: [...transfer("self", "A", "A", "2"), { action: "visible", selector: "#error" }, stock("A", 10), count(0)], sqliteChecks: databases(10, 0, []) },
  { name: "Reverse transfer", steps: [...transfer("one", "A", "B", "3"), count(1), ...transfer("two", "B", "A", "2"), stock("A", 9), stock("B", 1), count(2)], sqliteChecks: databases(9, 1, [once, ["two", "B", "A", 2]]) },
  { name: "Reload persists both sides", steps: [...transfer("one", "A", "B", "3"), count(1), { action: "reload" }, stock("A", 7), stock("B", 3), count(1)], sqliteChecks: databases(7, 3, [once]) },
] };
const prompt = `أنشئ تطبيقًا عربيًا RTL لنقل مخزون بين ثلاثة مستودعات A وB وC، بتصميم سماوي وبنفسجي متجاوب. الملفات index.html وserver.mjs وapp-verification.json في جذر المهمة. Node المدمج فقط، خادم 127.0.0.1:3000 وSQLite حقيقي /tmp/transfers.sqlite داخل الحاوية. جدول stock(warehouse TEXT PRIMARY KEY, quantity INTEGER NOT NULL) يبدأ A=10,B=0,C=0، وجدول transfers(requestId TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL, quantity INTEGER NOT NULL) يبدأ فارغًا. لا تعيد تهيئة البيانات عند القراءة أو reload.
GET /api/stock يعيد {items:[{warehouse,quantity}]} وGET /api/transfers يعيد {items:[{requestId,source,destination,quantity}]} من SQLite. POST /api/transfers يقبل {requestId,from,to,quantity}. المعرف نص غير فارغ، from وto مختلفان ومن A/B/C، quantity عدد صحيح آمن موجب من نوع number؛ المفقود أو النصي أو الكسري أو السلبي أو غير الصالح يرجع 400 دون أي أثر. نقل ناجح يرجع 201. نفّذ الخصم والإضافة وتسجيل النقل داخل معاملة واحدة، مع منع الرصيد السالب حتى مع الطلبات المتزامنة. نقص المخزون يرجع 409 دون تعديل أي جدول.
طلب بنفس requestId ونفس البيانات يعيد 200 دون تكرار أي أثر، حتى لو أصبح المخزون غير كافٍ لتنفيذ نقل جديد. نفس المعرف مع بيانات مختلفة يعيد 409. قارن هوية الطلب قبل فحص كفاية المخزون الجديد. استخدم معاملات ربط SQL. JSON معطوب يرجع 400 والخادم يستمر.
الواجهة: حقول نص عادية #requestId و#from و#to و#quantity وزر #transfer. صف لكل مستودع .stock[data-warehouse="A"] (وكذلك B/C)، داخله عنصر [data-quantity] يحتوي العدد فقط. صفوف النقل .transfer ورسالة خطأ عربية #error تظهر عند الرفض وتختفي بعد النجاح. تحقق بالواجهة من نفس المستودع والكمية غير الصالحة قبل الإرسال، وحوّل الكمية الصالحة إلى number. حدّث المخزون والسجل من الخادم بعد العملية وعند تحميل الصفحة. لا تستخدم localStorage أو بيانات وهمية أو مكتبات خارجية أو نوافذ تأكيد.
احفظ عقد الاختبار التالي دون تغيير: ${JSON.stringify(contract)}.
استخدم أدوات الملفات فقط، ولا تشغّل الخادم على Windows. المنظومة تختبره داخل Docker بصريًا ووظيفيًا وتقرأ SQLite. لا تدع دوام البيانات بعد حذف الحاوية.`;

async function probe(workspace: string) {
  const sandbox = await BackendSandbox.start(workspace, "server.mjs");
  try {
    const post = (body: unknown) => sandbox.request("/api/transfers", "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify(body)).toString("base64"));
    const request = { requestId: "same", from: "A", to: "B", quantity: 7 };
    assert.deepEqual((await Promise.all([post(request), post(request)])).map(r => r.status).sort(), [200, 201]);
    assert.equal((await post(request)).status, 200, "retry must succeed even when only three units remain");
    assert.equal((await post({ ...request, quantity: 1 })).status, 409);
    assert.deepEqual((await Promise.all([post({ ...request, requestId: "race1", quantity: 2 }), post({ ...request, requestId: "race2", quantity: 2 })])).map(r => r.status).sort(), [201, 409]);
    for (const quantity of [0, -1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await post({ ...request, requestId: "bad", quantity })).status, 400, `invalid quantity ${JSON.stringify(quantity)} must return 400`);
    for (const patch of [{ requestId: " " }, { from: "X" }, { to: "A" }]) assert.equal((await post({ ...request, ...patch })).status, 400, `invalid fields ${JSON.stringify(patch)} must return 400`);
    assert.equal((await sandbox.request("/api/transfers", "POST", { "content-type": "application/json" }, Buffer.from("{broken").toString("base64"))).status, 400);
    assert.equal((await post({ requestId: "reverse", from: "B", to: "A", quantity: 4 })).status, 201);
    const stockRows = await sandbox.readSqlite({ database: "/tmp/transfers.sqlite", table: "stock", columns: ["warehouse", "quantity"], rows: [] });
    assert.equal(canonicalRows(stockRows), canonicalRows([["A", 5], ["B", 5], ["C", 0]]));
    const transfers = await sandbox.readSqlite({ database: "/tmp/transfers.sqlite", table: "transfers", columns: ["requestId", "source", "destination", "quantity"], rows: [] });
    const winner = transfers.find(row => row[0] === "race1" || row[0] === "race2");
    assert.ok(winner);
    assert.equal(canonicalRows(transfers), canonicalRows([["same", "A", "B", 7], [winner[0]!, "A", "B", 2], ["reverse", "B", "A", 4]]));
    return { pass: true, stockRows, transfers, concurrentReplay: true, concurrentInsufficientStock: true, malformedJsonRejected: true, scope: "one ephemeral sandbox" };
  } finally { await sandbox.close(); }
}
const probeWorkspace = process.argv.find(arg => arg.startsWith("--probe-workspace="))?.slice("--probe-workspace=".length);
if (process.argv.includes("--repair")) {
  const api = (body: unknown) => ({ method: "POST", path: "/api/transfers", body: JSON.stringify(body) });
  const base = { requestId: "api-once", from: "A", to: "B", quantity: 7 };
  const initial = [stock("A", 10), stock("B", 0), count(0)];
  const enhanced = { ...contract, scenarios: [...contract.scenarios,
    { name: "API rejects invalid inputs", steps: initial, apiChecks: [
      ...[{ ...base, requestId: " " }, { ...base, requestId: "\t\n" }, { ...base, quantity: "1" }, { ...base, quantity: 0.5 }, { ...base, from: "X" }, {}].map(body => ({ requests: [api(body)], statuses: [400] })),
      { requests: [{ method: "POST", path: "/api/transfers", body: "{broken" }], statuses: [400] },
    ], sqliteChecks: databases(10, 0, []) },
    { name: "API concurrent identical replay", steps: initial, apiChecks: [
      { requests: [api(base), api(base)], statuses: [201, 200] },
      { requests: [api(base)], statuses: [200] },
      { requests: [api({ ...base, quantity: 1 })], statuses: [409] },
    ], sqliteChecks: databases(3, 7, [["api-once", "A", "B", 7]]) },
    { name: "API concurrent competing transfers", steps: initial, apiChecks: [
      { requests: [api({ ...base, requestId: "race1" }), api({ ...base, requestId: "race2" })], statuses: [201, 409] },
    ], sqliteChecks: [databases(3, 7, [])[0]!, { database: "/tmp/transfers.sqlite", table: "transfers", columns: ["source", "destination", "quantity"], rows: [["A", "B", 7]] }] },
  ] };
  const repairPrompt = `أصلح التطبيق الحالي في هذه المهمة مع الحفاظ على ميزاته واختباراته السبعة السابقة. الاختبار المستقل وجد أن requestId المكوّن من مسافات يُقبل كمعرف. للتوضيح الصريح: أي معرف لا يحتوي محارف غير بيضاء (بما فيها المسافات وtab وnewline) يجب أن يعيد 400 قبل أي أثر على المخزون أو السجل، مهما كانت كفاية المخزون. أصلح تحقق الخادم والواجهة عند الحاجة. لا تغيّر بيانات الطلبات الصالحة أو سلوك التكرار، ولا تُضعف الاختبارات.
أضفت ثلاثة سيناريوهات API إلى العقد، تُنفذ بعد خطوات الواجهة وقبل SQLite داخل الحاوية. طلبات المجموعة متزامنة، وstatuses قائمة الرموز المتوقعة دون اعتبار ترتيبها. لا تشغّل الخادم على Windows. استخدم أدوات الملفات فقط. سلّم النتيجة بعد فحص التشغيل والبصريات والبيانات.
احفظ عقد الاختبار التالي دون تغيير: ${JSON.stringify(enhanced)}`;
  parseAppContract(JSON.stringify(enhanced));
  if (process.argv.includes("--dry-run")) {
    fs.writeFileSync("docs/evidence/bot-transfers-repair-spec.json", JSON.stringify({ prompt: repairPrompt, contract: enhanced, status: "prepared, not executed" }, null, 2));
    console.log("PASS transfers repair specification parses with all seven original scenarios retained");
  } else await runInstalledCase({ taskId: "task_mvekt3qa69bbc61f4011", title: "اختبار BOT — إصلاح نقل المخزون وفحص API", prompt: repairPrompt, contract: enhanced, output: "docs/evidence/bot-installed-transfers-repair-live.json", probe });
} else if (probeWorkspace) {
  const evidence: Record<string, unknown> = { at: new Date().toISOString(), workspace: probeWorkspace, pass: false };
  try { evidence.result = await probe(probeWorkspace); evidence.pass = true; }
  catch (error) { evidence.error = String(error); process.exitCode = 1; console.error(error); }
  fs.writeFileSync("docs/evidence/bot-transfers-independent-diagnostic.json", JSON.stringify(evidence, null, 2));
} else if (process.argv.includes("--dry-run")) {
  parseAppContract(JSON.stringify(contract));
  fs.writeFileSync("docs/evidence/bot-transfers-test-spec.json", JSON.stringify({ prompt, contract, status: "prepared, not executed" }, null, 2));
  console.log("PASS transfers specification parses");
} else await runInstalledCase({ title: "اختبار BOT — نقل مخزون ذري ومنع التكرار", prompt, contract, output: "docs/evidence/bot-installed-transfers-live.json", probe });
