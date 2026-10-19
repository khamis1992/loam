import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { AgentEvent } from "../agent/events.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-history-live-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(root, "data");
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(root, "skills");
const { loadConfig } = await import("../config.js");
const { OllamaClient } = await import("../ollama.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { conversationHistory } = await import("../agent/history.js");
const { runOrchestratedAgent } = await import("../agent/orchestrator.js");
const cfg = loadConfig(); cfg.workspace = path.join(root, "workspace"); fs.mkdirSync(cfg.workspace);
cfg.model = process.env.LOAM_BOT_TEST_MODEL || "glm-5.3-flash:cloud"; cfg.fallbackModel = cfg.model;
cfg.orchestrator.plannerModel = cfg.model; cfg.orchestrator.verifierModel = cfg.model;
const tools = new ToolRegistry(); tools.registerAll(fileTools.filter(t => ["file_read", "file_write", "file_edit", "file_stat", "file_list"].includes(t.name)));
// Seeded history fixture, not a claim that the prior conversations were run live.
const turns = [{ role: "user", content: 'قواعد الإيصالات لهذه المهمة: احفظ receipt.json بجذر العمل. كائن JSON يحتوي فقط على المفاتيح currency,locale,subtotal,discount,tax,total,taxRate,discountRate. currency="SAR" وlocale="ar-SA". الخصم 10% من مجموع أسعار البنود ثم الضريبة 15% على المبلغ بعد الخصم. القيم المالية أرقام مقربة لمنزلتين. لا تستخدم شبكة. حافظ على هذه القواعد في الطلبات اللاحقة.' }, { role: "assistant", content: "تم تسجيل قواعد الإيصالات." }];
for (let i = 0; i < 18; i++) {
  turns.push({ role: "user", content: i === 3 ? "تصحيح دائم: ضريبة هذه المهمة 5% بدلًا من 15%، وتبقى على المبلغ بعد الخصم. باقي القواعد كما هي." : `متابعة تنظيمية ${i + 1}: لا تصدر الإيصال الآن؛ أبقِ القواعد المسجلة كما هي.` });
  turns.push({ role: "assistant", content: "تم، لن أصدر الإيصال الآن." });
}
const history = conversationHistory(turns);
const events: AgentEvent[] = []; const started = Date.now();
let failure: unknown;
try {
  const result = await runOrchestratedAgent({ cfg, ollama: new OllamaClient(cfg.ollamaUrl), tools, history, prompt: "الآن أصدر الإيصال لثلاث قطع سعر القطعة 100. طبّق القواعد المسجلة وتصحيحها، واحفظ الملف المطلوب؛ لا تسألني إعادة القواعد.", signal: AbortSignal.timeout(600_000), emit: e => { events.push(e); if (["verify", "revise", "error"].includes(e.type)) console.log(JSON.stringify(e)); } });
  assert.equal(result.verified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.workspace, "receipt.json"), "utf8")), { currency: "SAR", locale: "ar-SA", subtotal: 300, discount: 30, tax: 13.5, total: 283.5, taxRate: .05, discountRate: .1 });
} catch (e) { failure = e; }
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/bot-history-live.json", JSON.stringify({ at: new Date().toISOString(), model: cfg.model, workspace: cfg.workspace, seededHistoryMessages: turns.length, retainedUserMessages: history.filter(m => m.role === "user").length, ms: Date.now() - started, pass: !failure, ...(failure ? { error: String(failure) } : {}), events }, null, 2));
if (failure) throw failure;
console.log("PASS real-model receipt follows oldest user rules and earlier correction beyond the latest 12 messages; independent arithmetic assertions passed");
