import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:3939";
const retryTaskId = process.argv.find(a => a.startsWith("--task="))?.slice(7);
const capabilities = await (await fetch(`${base}/api/bot/capabilities`)).json() as { revision: number; creativeVerification?: { visualReview: boolean } };
assert.ok(capabilities.revision >= 4 && capabilities.creativeVerification?.visualReview);
const prompt = "أنشئ في الاستوديو مجسم سيارة لعبة حمراء مبسطة وواضحة المعالم، لها أربع عجلات سوداء على جانبيها، مقصورة وسقف، ونوافذ زرقاء فاتحة. أريد سيارة يمكن تمييزها بصريًا وليس صناديق تحمل أسماء أجزاء. استخدم loam_creative واقرأ المشهد أولًا، واضبط الكاميرا والإضاءة لتُرى السيارة كاملة. لا أطلب واقعية فوتوغرافية ولا فيديو ولا حركة. لا تستخدم HTML أو loam_canvas أو صورًا بديلة. لا تدّع تشغيل Blender. اترك الحكم البصري النهائي للنظام.";
const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(retryTaskId ? { taskId: retryTaskId } : {}), title: "اختبار BOT — سيارة وفحص بصري", mode: "media", workMode: "loam", model: "glm-5.3-flash:cloud", prompt: retryTaskId ? `المشهد المطلوب أدناه موجود بالفعل. المحاولة السابقة توقفت بسبب مهلة خدمة الفحص وليس بسبب حكم بصري برفض الجودة. اقرأ المشهد الحالي وأعد التحقق منه دون إعادة تصميمه أو تغيير الهندسة أو الخامات أو الكاميرا. اترك الصور والحكم النهائي للنظام. لا تدّع النجاح إذا تعذر الفحص. المطلوب الأصلي: ${prompt}` : prompt }), signal: AbortSignal.timeout(900_000) });
assert.ok(response.ok && response.body);
const events: Array<Record<string, unknown>> = [];
const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
let streamError: string | undefined;
try { for (;;) {
  const part = await reader.read(); if (part.done) break;
  buffer += decoder.decode(part.value, { stream: true });
  let end: number;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const line = block.split("\n").find(l => l.startsWith("data: ")); if (!line) continue;
    const event = JSON.parse(line.slice(6)); events.push(event);
    if (["task", "verify", "revise", "error", "done"].includes(event.type)) console.log(JSON.stringify(event));
  }
} } catch (error) { streamError = String(error); }
const taskId = String(events.find(e => e.type === "task")?.taskId ?? "");
const details = await (await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`)).json() as { task: { status: string; workspace: string } };
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/bot-installed-creative-live.json", JSON.stringify({ at: new Date().toISOString(), capabilities, taskId, task: details.task, continuation: Boolean(retryTaskId), streamError, events }, null, 2));
assert.equal(streamError, undefined, "live test interrupted; evidence preserved without assuming the task stopped");
assert.equal(details.task.status, "done");
assert.ok(events.some(e => e.type === "tool_result" && e.name === "creative_verification" && e.ok));
const done = events.findIndex(e => e.type === "done");
const verified = events.findIndex(e => e.type === "verify" && e.verdict === "pass");
assert.ok(verified >= 0 && done > verified);
assert.ok(events.findIndex(e => e.type === "assistant_message") > verified);
const root = path.resolve(details.task.workspace, ".verification");
// Only reports emitted by this attempt count; an older successful report in
// the same task workspace must never make a failed continuation pass.
const reports = events.filter(e => e.type === "tool_result" && e.name === "creative_verification" && e.ok).map(e => {
  const reportPath = String(e.summary).match(/\nReport: (.+)$/)?.[1]?.trim();
  assert.ok(reportPath, "current verification event must identify its report");
  const relative = path.relative(root, path.resolve(reportPath));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "report must belong to this task");
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
});
assert.ok(reports.length > 0 && reports.every(r => r.pass && r.screenshots.length >= 2 && r.visual?.verdict?.verdict === "pass"));
console.log(`PASS installed BOT ${retryTaskId ? "reverified the existing scene (continuation)" : "generated a 3D scene"}, rendered actual studio views, passed live visual review and persisted verified completion`);
