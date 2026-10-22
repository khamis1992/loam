import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const base = "http://127.0.0.1:3939";
const backend = process.argv.includes("--backend");
const capabilities = await (await fetch(`${base}/api/bot/capabilities`)).json() as { revision: number };
assert.ok(capabilities.revision >= 2);
if (backend) assert.ok(capabilities.revision >= 3);
const contract = { entry: "index.html", ...(backend ? { runtime: { type: "node", entry: "server.mjs" } } : {}), scenarios: [{ name: "Increment then reset", steps: [{ action: "textExact", selector: "#count", value: "0" }, { action: "click", selector: "#increment" }, { action: "textExact", selector: "#count", value: "1" }, ...(backend ? [{ action: "reload" }, { action: "textExact", selector: "#count", value: "1" }] : []), { action: "click", selector: "#reset" }, { action: "textExact", selector: "#count", value: "0" }] }] };
const prompt = `اختبار قبول للتحديث المثبت: أنشئ صفحة عداد عربية RTL متجاوبة بتصميم سماوي وبنفسجي في index.html بلا مكتبات أو شبكة خارجية. تبدأ القيمة صفرًا داخل #count وزر #increment يزيدها وزر #reset يعيدها لصفر. ${backend ? "أنشئ أيضًا server.mjs بخادم Node من وحداته المدمجة فقط على المنفذ 3000. يجب أن يكون العداد على الخادم عبر API حقيقي، وأن تستعيد الصفحة قيمته بعد إعادة التحميل؛ لا تستخدم localStorage أو عدادًا محليًا بديلًا. الخادم يخدم index.html وواجهات API. لا تشغله على جهاز ويندوز؛ نظام التحقق سيشغله داخل Docker المعزول تلقائيًا من عقد runtime. لا تستخدم shell أو أدوات المتصفح أو الاستوديو؛ أنشئ الملفات واقرأها فقط." : ""} احفظ app-verification.json بهذا العقد تمامًا: ${JSON.stringify(contract)}. استخدم file_write وfile_read مباشرةً. لا تستخدم أدوات الاستوديو. هذه مهمة حقيقية لإثبات تشغيل التطبيق والتحقق البصري، وليست إجابة نصية. لا تضف ميزات أخرى.`;
const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, title: "اختبار BOT المثبت — تشغيل وفحص بصري", mode: "build", workMode: "loam", model: "glm-5.3-flash:cloud" }), signal: AbortSignal.timeout(900_000) });
assert.ok(response.ok && response.body);
const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
const events: Array<Record<string, unknown>> = [];
for (;;) {
  const next = await reader.read(); if (next.done) break;
  buffer += decoder.decode(next.value, { stream: true });
  let end: number;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const line = block.split("\n").find(l => l.startsWith("data: "));
    if (!line) continue;
    const event = JSON.parse(line.slice(6)); events.push(event);
    if (["task", "verify", "done", "error"].includes(event.type)) console.log(JSON.stringify(event));
  }
}
const output = path.resolve(backend ? "docs/evidence/bot-installed-backend-live.json" : "docs/evidence/bot-installed-live.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
const taskId = String(events.find(e => e.type === "task")?.taskId ?? "");
const details = await (await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`)).json() as { task: { status: string; workspace: string } };
fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), capabilities, taskId, task: details.task, events }, null, 2));
assert.equal(details.task.status, "done");
const done = events.findIndex(e => e.type === "done");
assert.ok(done >= 0 && events.slice(0, done).some(e => e.type === "verify" && e.verdict === "pass"));
assert.ok(events.some(e => e.type === "tool_result" && e.name === "application_verification" && e.ok));
const evidenceRoot = path.join(details.task.workspace, ".verification");
const reports = fs.readdirSync(evidenceRoot).map(d => JSON.parse(fs.readFileSync(path.join(evidenceRoot, d, "report.json"), "utf8")));
assert.ok(reports.some(r => r.pass && r.checks.length === 2 && r.visual?.verdict?.verdict === "pass"));
if (backend) {
  assert.ok(reports.some(r => r.pass && r.runtime?.type === "node" && r.runtime?.freshBackendPerScenario === true));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(details.task.workspace, "app-verification.json"), "utf8")), contract, "generated task preserves user acceptance contract");
  assert.ok(events.filter(e => e.type === "tool_call").every(e => ["file_write", "file_read", "file_edit", "file_stat", "file_list", "file_search"].includes(String(e.name))), "backend generation must honor file-only execution; server is started only by the trusted sandbox verifier");
}
const delivered = String(events[done]?.text ?? "");
assert.ok(delivered.includes("index.html") && delivered.includes("report.json"), "delivery preserves artifact and verification report references");
assert.ok(!/سيتم|سينفذ|سيشغل|سوف|will (?:run|be verified)/i.test(delivered.replace(/[\u064B-\u065F\u0670]/g, "")), "delivery must not defer already-completed verification");
assert.equal(events.find(e => e.type === "assistant_message")?.text, delivered, "message and persisted completion agree");
console.log(`PASS installed runtime generated app, ran desktop/mobile interactions, visually reviewed images and persisted verified completion: ${output}`);
