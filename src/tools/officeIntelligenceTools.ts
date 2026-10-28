/**
 * Office intelligence tools: expose the office-intelligence suite (17
 * capabilities over DOCX/XLSX/PPTX artifacts, src/office/intelligence) to
 * agent runs through one polling tool `office_intelligence_run`. The tool
 * describes the artifact, starts a run through the same service the HTTP API
 * uses, and polls it to completion. It only READS the artifact: a run that
 * proposes edits returns a change-set preview, and applying it stays behind
 * the UI approve flow — this tool never writes the office file.
 *
 * NOTICE: the implementation below is original Loam TypeScript over the
 * existing office-intelligence service; no third-party code, brand or assets
 * are used.
 */
import path from "node:path";
import type { Config } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { getSettings } from "../server/settings.js";
import type { Tool, ToolResult } from "./registry.js";
import { str, num } from "./registry.js";
import { createOfficeModelGateway, type OfficeModelGateway } from "../office/intelligence/modelGateway.js";
import { loadOfficeArtifact } from "../office/intelligence/artifactIO.js";
import { getOfficeRun, startOfficeRun } from "../office/intelligence/service.js";
import {
  OFFICE_CAPABILITIES,
  OfficeIntelligenceError,
  assertCapabilityMatchesArtifact,
  type OfficeArtifactKind,
  type OfficeCapability,
  type OfficeRun,
} from "../office/intelligence/contracts.js";

/** Capabilities that run on pure spreadsheet/document analysis and therefore
 *  work with no model configured at all. Surfaced whenever a model-dependent
 *  run fails so the agent can fall back without another round trip. */
const DETERMINISTIC_CAPABILITIES = "sheet-analysis، sheet-anomalies، sheet-cleaning، sheet-forecast، sheet-formula، legal-matter-timeline";

const POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_MS = 120_000;
const CONTENT_TRIM = 4_000;

/** Capability-appropriate neutral Arabic instructions, used when the caller
 *  does not supply one. They guide, never answer: the result still comes from
 *  the artifact's own content with citations. */
const DEFAULT_INSTRUCTIONS: Record<OfficeCapability, string> = {
  "doc-summary": "لخّص المستند بنقاط واضحة تغطي أقسامه الأساسية دون إضافة أي معلومة من خارجه.",
  "doc-grounded-draft": "اكتب مسودة مبنية على مصدر الملف فقط مع مراجع المقاطع المستخدمة، واذكر ما هو ناقص صراحة.",
  "doc-actions": "استخرج القرارات والمهام والمسؤولين والمواعيد مع مصادرها، ولا تخترع البيانات الناقصة.",
  "doc-compare": "اعرض الفروق الجوهرية بين محتوى المستند وما تصفه التعليمة، مع الإشارة إلى مواضعها.",
  "sheet-formula": "اشرح الصيغة المحددة في التعليمة أو أول صيغة في الجدول: دلالتها ومراجعها وحدود صحة نتيجتها.",
  "sheet-analysis": "حلل البيانات وقدم مؤشراتها الرئيسية وتحذيرات جودة البيانات.",
  "sheet-cleaning": "اقترح خطة تنظيف للبيانات (تكرار، تواريخ، مسافات زائدة) دون تطبيق أي تعديل.",
  "sheet-anomalies": "رصد القيم الشاذة إحصائيًا مع بيان مواضعها، دون الحكم على أسبابها.",
  "sheet-forecast": "أنشئ توقعًا إرشاديًا للسلسلة الرقمية الأنسب مع عرض الافتراضات وهامش الخطأ.",
  "slides-storyboard": "اقترح هيكل شرائح (عناوين ونقاط) يخدم هدف التعليمة بناءً على محتوى العرض الحالي.",
  "slides-deck": "طوّر العرض وفق التعليمة مع الحفاظ على لغته وهويته البصرية.",
  "legal-research": "ابحث في المسألة الموصوفة بدلالات موثقة، مع التمييز بين الوقائع والتحليل والافتراضات.",
  "legal-matter-timeline": "رتّب أحداث القضية في تسلسل زمني مع مصدر كل حدث، دون استنتاج مواعيد إجرائية.",
  "legal-evidence-matrix": "ابنِ مصفوفة الأدلة: كل ادعاء مع أدلته المتاحة وما ينقصه من إثبات.",
  "legal-partner-review": "راجع العمل بمنظور شريك: نقاط القوة، المخاطر، الأسئلة الناقصة وما يحتاج قرارًا.",
  "legal-contract-review": "راجع العقد: الالتزامات، المخاطر، الغموض والبنود الناقصة مع الإشارة إلى مواضعها.",
  "legal-client-brief": "أعد موجزًا للعميل يشرح الموقف والخطوات المقترحة بلغة واضحة غير متخصصة.",
};

const kindForExtension = (extension: string): OfficeArtifactKind | null =>
  extension === "docx" ? "document" : extension === "xlsx" ? "spreadsheet" : extension === "pptx" ? "presentation" : null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Model/gateway unavailability fingerprints. The gateway reports 503
 *  "no Office intelligence model is configured"; an unreachable provider
 *  surfaces as a fetch/connect failure. Both mean: use a deterministic
 *  capability instead, not "retry harder". */
function looksLikeModelFailure(errorText: string): boolean {
  return /model|ollama|503|fetch|connect|econn|timeout/i.test(errorText);
}

function renderCitations(run: OfficeRun): string {
  const result = run.result;
  if (!result) return `معرف التشغيل: ${run.id} • الحالة: ${run.status}`;
  const lines: string[] = [result.summary];
  if (result.content) {
    lines.push("", result.content.length > CONTENT_TRIM
      ? `${result.content.slice(0, CONTENT_TRIM)}\n[… اقتُطع ${result.content.length - CONTENT_TRIM} حرفًا]`
      : result.content);
  }
  const first = result.citations.slice(0, 3).map((anchor) => `${anchor.kind}:${anchor.anchor}`).join("، ");
  lines.push("", `المصادر: ${result.citations.length} مرجعًا${first ? ` (أولها: ${first})` : ""}`);
  if (result.warnings.length) lines.push(`تحذيرات: ${result.warnings.join("؛ ")}`);
  if (result.changeSet) {
    lines.push("", `مقترح تعديلات على ${run.artifact.path} (لم يُطبَّق):`);
    for (const preview of result.changeSet.preview.slice(0, 12)) lines.push(`— ${preview}`);
    lines.push("تطبيق هذه التعديلات يحتاج موافقة المستخدم في واجهة الاستوديو؛ لم يُعدَّل الملف تلقائيًا.");
  }
  lines.push("", `معرف التشغيل: ${run.id} • الحالة: ${run.status}`);
  return lines.join("\n");
}

export interface OfficeIntelligenceDeps {
  loadArtifact?: typeof loadOfficeArtifact;
  startRun?: typeof startOfficeRun;
  getRun?: typeof getOfficeRun;
  /** Model gateway factory; tests inject a stub to avoid the provider client. */
  modelGateway?: (cfg: Config, ollama: OllamaClient) => OfficeModelGateway;
}

export function createOfficeIntelligenceTools(deps: OfficeIntelligenceDeps = {}): Tool[] {
  const doLoad = deps.loadArtifact ?? loadOfficeArtifact;
  const doStart = deps.startRun ?? startOfficeRun;
  const doGet = deps.getRun ?? getOfficeRun;
  const doGateway = deps.modelGateway ?? ((cfg, ollama) => createOfficeModelGateway(cfg, ollama));
  return [
    {
      name: "office_intelligence_run",
      description: "شغّل إحدى قدرات ذكاء الأوفيس السبع عشرة (تلخيص مستند، مسودة موثقة، استخراج قرارات، تحليل جداول، شذوذ، تنظيف، توقع، شرح صيغ، عروض، وقدرات قانونية) على ملف DOCX/XLSX/PPTX في مساحة المهمة، وانتظر النتيجة مع مراجع مصادرها. قدرات الجداول والخط الزمني حتمية وتعمل بلا نموذج. لا يُطبَّق أي تعديل تلقائيًا: مقترحات التعديل تعود كمعاينة والتطبيق يحتاج موافقة المستخدم في الواجهة.",
      parameters: {
        type: "object",
        properties: {
          capability: { type: "string", enum: [...OFFICE_CAPABILITIES], description: "معرف القدرة المطلوبة (مثل sheet-analysis أو doc-summary)" },
          path: { type: "string", description: "المسار النسبي لملف الأوفيس في مساحة المهمة (مثل uploads/report.xlsx)" },
          taskId: { type: "string", description: "معرف المهمة لربط التشغيل بها (اختياري)" },
          instruction: { type: "string", description: "تعليمة توجه القدرة (اختياري؛ الافتراضي تعليمة محايدة مناسبة لكل قدرة)" },
          waitMs: { type: "number", description: "مدة انتظار اكتمال التشغيل بالملّي ثانية قبل إعادته كمستمر في الخلفية (افتراضي 120000)" },
        },
        required: ["capability", "path"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const capability = str(args, "capability").trim() as OfficeCapability;
        const rel = str(args, "path").trim();
        if (!capability || !OFFICE_CAPABILITIES.includes(capability)) {
          return { ok: false, content: `قدرة غير معروفة: ${capability || "(فارغة)"}. القدرات المتاحة: ${OFFICE_CAPABILITIES.join("، ")}.` };
        }
        if (!rel) return { ok: false, content: "المعامل path مطلوب." };
        const kind = kindForExtension(path.extname(rel).toLowerCase().slice(1));
        if (!kind) return { ok: false, content: "الأداة تدعم DOCX وXLSX وPPTX فقط؛ الامتداد لا يُناظر نوعًا معروفًا." };
        try {
          assertCapabilityMatchesArtifact(capability, kind);
        } catch (error) {
          return { ok: false, content: `القدرة ${capability} لا تعمل على ${kind}: ${error instanceof Error ? error.message : String(error)}` };
        }
        const taskId = str(args, "taskId").trim() || (typeof ctx.taskId === "string" && ctx.taskId ? ctx.taskId : "local");
        const instruction = str(args, "instruction").trim() || DEFAULT_INSTRUCTIONS[capability];
        const waitMs = Math.max(0, num(args, "waitMs", DEFAULT_WAIT_MS));
        const gateway = doGateway(ctx.cfg, new OllamaClient(ctx.cfg.ollamaUrl));
        // د2: attribute runs to the configured user when an identity name is set.
        const identityName = getSettings().officeIdentity?.name?.trim();
        const actorId = identityName ? `agent:${identityName}` : "agent";
        try {
          const loaded = await doLoad(ctx.workspace, { taskId, path: rel.split(path.sep).join("/"), kind, tenantId: "local" });
          const started = doStart(
            { capability, artifact: loaded.ref, scope: { tenantId: "local" }, actorId, instruction },
            { workspace: ctx.workspace, model: gateway },
          );
          const deadline = Date.now() + waitMs;
          let run = doGet(started.id);
          while (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled" && Date.now() < deadline) {
            await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
            run = doGet(started.id);
          }
          if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled") {
            const state = run.status === "queued" ? "في قائمة الانتظار" : "قيد التنفيذ";
            return {
              ok: true,
              content: `التشغيل ${run.id} ما يزال ${state} بعد ${waitMs} ملّي ثانية — يستمر في الخلفية ويمكن الاستعلام عن نتيجته لاحقًا بنفس المعرف.`,
            };
          }
          if (run.status === "succeeded") return { ok: true, content: renderCitations(run) };
          if (run.status === "cancelled") return { ok: false, content: `أُلغي التشغيل ${run.id} قبل اكتماله.` };
          const error = run.error ?? "سبب غير معروف";
          if (looksLikeModelFailure(error)) {
            return {
              ok: false,
              content: `فشل التشغيل ${run.id} لأن النموذج غير متاح: ${error}\nالقدرات الحتمية التي لا تحتاج نموذجًا: ${DETERMINISTIC_CAPABILITIES} — استخدم إحداها إن كانت تكفي المهمة.`,
            };
          }
          return { ok: false, content: `فشل التشغيل ${run.id}: ${error}` };
        } catch (error) {
          if (error instanceof OfficeIntelligenceError) {
            const hint = error.status === 503 || error.code === "model_unavailable" ? `\nالقدرات الحتمية التي لا تحتاج نموذجًا: ${DETERMINISTIC_CAPABILITIES}.` : "";
            return { ok: false, content: `تعذّر تشغيل قدرة الأوفيس: ${error.message}${hint}` };
          }
          return { ok: false, content: `تعذّر تشغيل قدرة الأوفيس: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}

export const OFFICE_INTELLIGENCE_TOOL_NAMES = ["office_intelligence_run"];
