import assert from "node:assert/strict";
import fs from "node:fs";
import { BackendSandbox } from "../agent/backendSandbox.js";
import { canonicalRows } from "../agent/sqliteChecks.js";
import { parseAppContract } from "../agent/appVerification.js";
import { runInstalledCase } from "./installed-bot-case.js";
const time = (hour: string) => `2026-11-01T${hour}:00:00Z`;
const fill = (selector: string, value: string) => ({ action: "fill", selector, value });
const book = (room: string, start: string, end: string) => [fill("#room", room), fill("#start", time(start)), fill("#end", time(end)), { action: "click", selector: "#save" }];
const count = (n: number) => ({ action: "count", selector: ".booking", count: n });
const row = (room: string, start: string, end: string) => [room, time(start), time(end)];
const database = (rows: string[][]) => [{ database: "/tmp/bookings.sqlite", table: "bookings", columns: ["room", "start", "end"], rows }];
const base = row("A", "10", "11");
const rejected = [{ method: "POST", path: "/api/bookings", status: 409, count: 1 }];
const contract = { entry: "index.html", runtime: { type: "node", entry: "server.mjs" }, scenarios: [
  { name: "Create booking", steps: [...book("A", "10", "11"), count(1)], sqliteChecks: database([base]) },
  { name: "Reject overlapping room", steps: [...book("A", "10", "11"), count(1), ...book("A", "10", "12"), { action: "visible", selector: "#error" }, count(1)], expectedResponses: rejected, sqliteChecks: database([base]) },
  { name: "Allow adjacent time", steps: [...book("A", "10", "11"), count(1), ...book("A", "11", "12"), count(2)], sqliteChecks: database([base, row("A", "11", "12")]) },
  { name: "Independent rooms", steps: [...book("A", "10", "11"), count(1), ...book("B", "10", "11"), count(2)], sqliteChecks: database([base, row("B", "10", "11")]) },
  { name: "Reject reversed time", steps: [...book("A", "12", "10"), { action: "visible", selector: "#error" }, count(0)], sqliteChecks: database([]) },
  { name: "Reload persistence", steps: [...book("A", "10", "11"), count(1), { action: "reload" }, count(1)], sqliteChecks: database([base]) },
] };
const prompt = `أنشئ تطبيق حجز غرف عربي RTL بتصميم سماوي وبنفسجي متجاوب. الملفات index.html وserver.mjs وapp-verification.json في جذر مساحة المهمة بمسارات نسبية. استخدم Node المدمج فقط وخادم 127.0.0.1:3000 وقاعدة SQLite حقيقية داخل الحاوية /tmp/bookings.sqlite وجدول bookings(id INTEGER PRIMARY KEY, room TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL). تبدأ القاعدة فارغة.
GET /api/bookings يعيد {items:[{id,room,start,end}]} من قاعدة البيانات. POST /api/bookings يقبل {room,start,end}؛ room نص غير فارغ والتاريخان نصان UTC بالصيغة YYYY-MM-DDTHH:mm:ssZ يمثلان تاريخًا صالحًا فعليًا وstart<end، وإلا 400. ينشئ الحجز ويرجع 201. إذا تعارض مع حجز في نفس الغرفة يعيد 409 دون تغيير البيانات. حدود الفترات نصف مفتوحة: بداية حجز جديد تساوي نهاية السابق مسموحة. غرف مختلفة مستقلة. الفحص والإدخال داخل معاملة واحدة لمنع قبول طلبين متعارضين متزامنين؛ استخدم SQL بمعاملات ربط.
واجهة تحتوي حقول نصية #room و#start و#end وزر #save ورسالة عربية #error وصفوف .booking تعرض الغرفة والبداية والنهاية. استعمل حقول نص عادية لتقبل صيغة UTC المذكورة، دون قيود HTML تخفي رسالة الخطأ. حدّث الجدول من الخادم بعد كل عملية وعند التحميل. عالج ردود fetch وأظهر تعارض الحجز وانعكاس الوقت. لا تستخدم localStorage أو ذاكرة بديلة عن SQLite، ولا نوافذ تأكيد أو مكتبات خارجية.
احفظ عقد الاختبار التالي دون تغيير: ${JSON.stringify(contract)}.
استخدم أدوات الملفات فقط، ولا تشغل الخادم على Windows. المنظومة تشغله داخل Docker وتتحقق بصريًا ووظيفيًا ومن قاعدة البيانات. لا تدّع دوام البيانات بعد حذف الحاوية.`;

async function probe(workspace: string) {
  const sandbox = await BackendSandbox.start(workspace, "server.mjs");
  try {
    const post = (room: string, start: string, end: string) => sandbox.request("/api/bookings", "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ room, start, end })).toString("base64"));
    const competing = await Promise.all([post("race", time("10"), time("12")), post("race", time("10"), time("12"))]);
    assert.deepEqual(competing.map(x => x.status).sort(), [201, 409]);
    assert.equal((await post("race", time("12"), time("13"))).status, 201);
    assert.equal((await post("race", time("09"), time("11"))).status, 409);
    assert.equal((await post("race", time("09"), time("14"))).status, 409);
    assert.equal((await post("other", time("10"), time("12"))).status, 201);
    for (const [start,end] of [[time("12"),time("12")],[time("13"),time("12")],["2026-02-30T10:00:00Z",time("12")],["nonsense",time("12")]] as const) assert.equal((await post("bad",start,end)).status,400);
    assert.equal((await post(" ",time("10"),time("12"))).status,400);
    const quoted = "x' OR 1=1 --";
    assert.equal((await post(quoted,time("10"),time("12"))).status,201);
    const expected = [row("race","10","12"),row("race","12","13"),row("other","10","12"),row(quoted,"10","12")];
    const actual = await sandbox.readSqlite({ database: "/tmp/bookings.sqlite", table: "bookings", columns: ["room","start","end"], rows: expected });
    assert.equal(canonicalRows(actual),canonicalRows(expected));
    return { pass: true, actual, concurrentConflict: true, containmentOverlap: true, adjacentAllowed: true, invalidDatesRejected: true, scope: "one ephemeral sandbox" };
  } finally { await sandbox.close(); }
}
if (process.argv.includes("--dry-run")) {
  parseAppContract(JSON.stringify(contract));
  fs.writeFileSync("docs/evidence/bot-bookings-test-spec.json",JSON.stringify({ prompt,contract,status:"prepared, not executed" },null,2));
  console.log("PASS booking test specification parses; no live task started");
} else await runInstalledCase({ title: "اختبار BOT — حجوزات متعارضة", prompt, contract, output: "docs/evidence/bot-installed-bookings-live.json", probe });
