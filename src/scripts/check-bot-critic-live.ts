import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { critiqueStep } from "../agent/verifier.js";
import { ToolRegistry } from "../tools/registry.js";
const cfg = loadConfig();
cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-critic-live-"));
const ollama = new OllamaClient(cfg.ollamaUrl);
const results: unknown[] = [];
const output = "docs/evidence/bot-critic-live.json";
for (const conditional of [true, false]) {
  const source = `import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('ok'));
server.listen(3000, '127.0.0.1');
${conditional ? "function shutdown() {\nserver.close(() => process.exit(0));\nsetTimeout(() => process.exit(0), 2000).unref();\n}\nprocess.on('SIGTERM', shutdown);" : "setTimeout(() => process.exit(0), 2000);"}
`;
  fs.writeFileSync(path.join(cfg.workspace, "server.mjs"), source);
  let reads = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "file_read", description: "Read the complete current source file server.mjs, including control flow around the exit timer.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, run: async args => {
    if (args.path !== "server.mjs") return { ok: false, content: "Only server.mjs exists in this fixture." };
    reads++; return { ok: true, content: fs.readFileSync(path.join(cfg.workspace, "server.mjs"), "utf8") };
  } });
  const verdict = await critiqueStep({ cfg, ollama, tools, goal: "خادم ويب مستمر", request: "اكتب خادم Node يستمع على 127.0.0.1:3000 ويستمر في الخدمة حتى إيقافه خارجيًا. يسمح بمعالج إغلاق نظيف عند SIGTERM.", step: { id: "s1", title: "فحص مصدر الخادم", instruction: "تحقق من منطق الاستماع والإغلاق بقراءة الكود الحالي. اختبار التشغيل مرحلة لاحقة مستقلة.", successCriteria: "الكود يستمع على 127.0.0.1:3000 ولا ينهي العملية تلقائيًا أثناء التشغيل العادي. مؤقت داخل معالج SIGTERM فقط مسموح." }, stepIndex: 0, totalSteps: 2, attempt: 1, maxAttempts: 2, workerText: "الملف محفوظ. اقرأ السياق الكامل قبل الحكم.", trace: [{ name: "file_search", ok: true, summary: "Excerpt without surrounding context: setTimeout(() => process.exit(0), 2000)" }] });
  results.push({ conditional, source, reads, verdict });
  fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), workspace: cfg.workspace, results, pass: false }, null, 2));
  assert.ok(reads > 0, "critic must inspect actual context rather than infer from excerpt");
  assert.equal(verdict.verdict === "pass", conditional, JSON.stringify(verdict));
  console.log(`PASS real critic ${conditional ? "accepts signal-only shutdown" : "rejects unconditional exit"}`);
}
fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), workspace: cfg.workspace, results, pass: true }, null, 2));
