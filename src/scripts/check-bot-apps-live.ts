/** Multi-turn real-model application build, extension, browser and visual checks. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AgentEvent } from "../agent/events.js";
const output = path.resolve(process.argv.find(a => a.startsWith("--output="))?.slice(9) || "docs/evidence/bot-apps-live.json");
const continued = process.argv.includes("--resume-latest") ? JSON.parse(fs.readFileSync(output, "utf8")) as { at: string; workspace: string; results: Array<{ turn?: number; pass: boolean; events?: AgentEvent[] }> } : undefined;
if (continued && !continued.results.some(r => r.turn === 0 && r.pass)) throw new Error("Continuation requires a verified first round");
const root = continued ? path.dirname(continued.workspace) : fs.mkdtempSync(path.join(os.tmpdir(), "loam-long-app-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(root, "data");
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(root, "skills");
const { loadConfig } = await import("../config.js");
const { OllamaClient } = await import("../ollama.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { runOrchestratedAgent } = await import("../agent/orchestrator.js");
const { verifyApplication } = await import("../agent/appVerification.js");
const cfg = loadConfig();
cfg.workspace = path.join(root, "workspace"); fs.mkdirSync(cfg.workspace, { recursive: true });
cfg.model = process.env.LOAM_BOT_TEST_MODEL || "glm-5.3-flash:cloud";
cfg.fallbackModel = cfg.model; cfg.vision.model = cfg.model;
cfg.orchestrator.plannerModel = cfg.model; cfg.orchestrator.verifierModel = cfg.model;
cfg.orchestrator.maxPlanSteps = 5; cfg.orchestrator.maxStepsPerWorker = 12;
cfg.orchestrator.maxRevisionsPerStep = 1; cfg.orchestrator.maxReplans = 1;
cfg.policy.allowOutsideWorkspaceRead = false;
const ollama = new OllamaClient(cfg.ollamaUrl);
const tools = new ToolRegistry();
tools.registerAll(fileTools.filter(t => ["file_read", "file_write", "file_edit", "file_list", "file_stat"].includes(t.name)).map(t => ({ ...t, run: async (args, ctx) => {
  if (["file_write", "file_edit"].includes(t.name) && path.resolve(ctx.workspace, String(args.path)) === path.join(ctx.workspace, "app-verification.json")) return { ok: false, content: "Acceptance contract is user-owned and immutable. Fix the app, not the tests." };
  return t.run(args, ctx);
} })));
const fill = (selector: string, value: string) => ({ action: "fill", selector, value });
const click = (selector: string) => ({ action: "click", selector });
const text = (selector: string, value: string) => ({ action: selector === "#total" ? "textExact" : "text", selector, value });
const count = (selector: string, count: number) => ({ action: "count", selector, count });
const add = (title: string, amount: string, category = "food") => [fill("#title", title), fill("#amount", amount), { action: "select", selector: "#category", value: category }, click("#add")];
const scenarios = [
  { name: "Adding entries calculates sum", steps: [...add("خبز", "12.5"), ...add("حافلة", "7.5", "transport"), count(".expense", 2), text("#total", "20")] },
  { name: "Persistence after reload", steps: [...add("قهوة", "9"), { action: "reload" }, text("#entries", "قهوة"), text("#total", "9")] },
  { name: "Deleting recomputes total", steps: [...add("حليب", "10"), click(".expense .delete"), count(".expense", 0), text("#total", "0")] },
  { name: "Invalid input rejected", steps: [...add("خطأ", "-1"), count(".expense", 0), { action: "visible", selector: "#error" }] },
];
const manifest = path.join(cfg.workspace, "app-verification.json");
const saveContract = () => fs.writeFileSync(manifest, JSON.stringify({ entry: "index.html", scenarios }, null, 2));
const sha = () => createHash("sha256").update(fs.readFileSync(manifest)).digest("hex");
const base = `أنشئ تطبيق مصروفات عربي RTL احترافي داخل index.html بدون مكتبات خارجية. يعمل محليًا، ويحفظ البيانات في localStorage. تصميم سماوي وبنفسجي متجاوب. المطلوب إضافة عنوان ومبلغ موجب وفئة، عرض العناصر والمجموع، حذف عنصر وتحديث المجموع، واستعادة البيانات بعد إعادة التحميل. الفئات food وtransport وother بعناوين عربية. استخدم المحددات #title و#amount و#category و#add و#error و#entries و#total، ولكل عنصر .expense وزر .delete. اقرأ عقد القبول app-verification.json: هو اختبارات المستخدم الثابتة ولا يمكنك تغييره. لا تستخدم شبكة أو خادم خلفي. احفظ التطبيق الكامل، واترك اختبار تشغيل المتصفح والتحقق البصري الإلزامي للنظام. لا تزعم تشغيل اختبارات بنفسك.`;
const results: unknown[] = continued ? continued.results.filter(r => r.turn === 0 && r.pass) : [];
const previousAnswer = continued?.results.find(r => r.turn === 0 && r.pass)?.events?.find(e => e.type === "assistant_message");
let previous = previousAnswer?.type === "assistant_message" ? previousAnswer.text : "";
for (let turn = continued ? 1 : 0; turn < 2; turn++) {
  if (turn === 1) {
    scenarios.push({ name: "Filtering shows matching entries and subtotal", steps: [...add("طعام", "15"), ...add("سيارة", "8", "transport"), { action: "select", selector: "#filter", value: "food" }, count(".expense", 1), text("#total", "15")] });
    scenarios.push({ name: "Reset clears persisted entries", steps: [...add("إزالة", "6"), click("#reset"), count(".expense", 0), { action: "reload" }, count(".expense", 0), text("#total", "0")] });
  }
  saveContract(); const expected = sha();
  const prompt = turn === 0 ? base : base + "\nالآن طوّر التطبيق الموجود مع الحفاظ على جميع الوظائف: أضف فلتر الفئة #filter بالقيم all وfood وtransport وother. المجموع يعكس العناصر المعروضة. أضف زر #reset يمسح البيانات فورًا بما فيها التخزين. اقرأ عقد القبول المحدّث وحقق الستة سيناريوهات. احتفظ بالتصميم العربي المتجاوب.";
  const events: AgentEvent[] = [];
  const started = Date.now();
  try {
    const run = await runOrchestratedAgent({ cfg, ollama, tools, prompt, ...(previous ? { history: [{ role: "user" as const, content: base }, { role: "assistant" as const, content: previous }] } : {}), signal: AbortSignal.timeout(900_000), emit: e => { events.push(e); if (["plan", "critique", "verify", "revise"].includes(e.type)) console.log(JSON.stringify(e)); } });
    assert.equal(sha(), expected, "agent cannot weaken user tests");
    assert.equal(run.verified, true);
    assert.ok(events.findIndex(e => e.type === "done") > events.findIndex(e => e.type === "verify" && e.verdict === "pass"));
    previous = run.text;
    results.push({ turn, pass: true, ms: Date.now() - started, usage: run.usage, steps: run.steps, events });
  } catch (error) { results.push({ turn, pass: false, ms: Date.now() - started, error: String(error), events }); break; }
}
// Independent holdout: corrupt a working control; a genuine verifier must reject it.
if (results.length === 2 && results.every(r => (r as { pass: boolean }).pass)) {
  const entry = path.join(cfg.workspace, "index.html"); const original = fs.readFileSync(entry, "utf8");
  fs.writeFileSync(entry, original + '<script>document.querySelector("#add").disabled=true</script>');
  const start = Date.now();
  const rejection = await verifyApplication({ cfg, ollama, request: base });
  results.push({ id: "broken-control-holdout", pass: !rejection.pass, ms: Date.now() - start, report: rejection });
  fs.writeFileSync(entry, original);
  fs.writeFileSync(entry, original + '<style>body{opacity:0!important}</style>');
  const visualStart = Date.now();
  const blank = await verifyApplication({ cfg, ollama, request: base });
  results.push({ id: "blank-render-visual-holdout", pass: !blank.pass && blank.checks.every(c => c.pass) && Boolean(blank.visual), ms: Date.now() - visualStart, report: blank });
  fs.writeFileSync(entry, original);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), model: cfg.model, workspace: cfg.workspace, ...(continued ? { continuation: true, previousAttemptAt: continued.at, previousAttemptEvidence: "bot-apps-live-attempt2.json" } : {}), results }, null, 2));
console.log(output);
if (results.length < 4 || results.some(r => !(r as { pass: boolean }).pass)) process.exitCode = 1;
