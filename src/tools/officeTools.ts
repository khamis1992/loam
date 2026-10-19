/** Office companion tools: bridge the studio's real DOCX/XLSX/PPTX import/export
 * to the companion gateway so a companion can do the full office cycle. */
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./registry.js";
import { str, num, bool } from "./registry.js";
import { taskPath } from "../server/taskWorkspace.js";
import { readStudio, saveStudio, type StudioArtifact } from "../studio/store.js";
import { importStudio } from "../studio/import.js";
import { exportStudio } from "../studio/export.js";

export function createOfficeTools(): Tool[] {
  return [
    {
      name: "office_import",
      description: "استورد ملف أوفيس (DOCX/XLSX/PPTX) من مساحة المهمة إلى الاستوديو الحي ليصبح قابلًا للتحرير. يعيد مراجعة المحتوى المستورد.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "المسار النسبي للملف في مساحة المهمة (مثل uploads/report.docx)" },
        },
        required: ["path"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "path").trim();
        const file = taskPath(ctx.workspace, rel);
        if (!fs.existsSync(file)) return { ok: false, content: `الملف غير موجود: ${rel}` };
        const buffer = fs.readFileSync(file);
        try {
          const artifact = await importStudio(ctx.workspace, buffer, path.basename(rel), 0);
          return { ok: true, content: `استُورد «${rel}» (${artifact.kind}) — الآن قابل للتحرير عبر loam_studio والتصدير عبر office_export. المحتوى: ${JSON.stringify(artifact.content).slice(0, 400)}…` };
        } catch (err) {
          return { ok: false, content: `فشل الاستيراد: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "office_export",
      description: "صدّر الاستوديو الحي كملف أوفيس فعلي (DOCX للمستند، XLSX للجدول، PPTX للعرض) في مساحة المهمة. النتيجة تُفتح في أوفيس ويندوز.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "مسار الإخراج النسبي (اختياري — يُولَّد تلقائيًا)" },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const artifact = readStudio(ctx.workspace);
        if (!artifact) return { ok: false, content: "لا يوجد استوديو نشط لهذه المهمة — أنشئ محتوى أولًا بـ loam_studio أو office_import" };
        try {
          const output = await exportStudio(artifact, ctx.workspace);
          const rel = str(args, "path").trim() || `uploads/${output.filename}`;
          const out = taskPath(ctx.workspace, rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, output.buffer);
          return { ok: true, content: `صُدِّر ${output.filename} (${output.contentType.split("/").pop()}) إلى ${rel} (${output.buffer.length} بايت) — قابل للفتح في أوفيس ومن مساحة المهمة.` };
        } catch (err) {
          return { ok: false, content: `فشل التصدير: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "office_status",
      description: "اعرف حالة الاستوديو الحي: النوع (مستند/جدول/عرض) وعدد العناصر والمراجعة.",
      parameters: { type: "object", properties: {} },
      async run(args, ctx): Promise<ToolResult> {
        const artifact = readStudio(ctx.workspace);
        if (!artifact) return { ok: true, content: "لا يوجد استوديو نشط" };
        const kindMap: Record<string, number> = { document: (artifact.content as { blocks?: unknown[] }).blocks?.length ?? 0, presentation: (artifact.content as { slides?: unknown[] }).slides?.length ?? 0, spreadsheet: (artifact.content as { sheets?: unknown[] }).sheets?.length ?? 0 };
        const count = kindMap[artifact.kind] ?? 0;
        return { ok: true, content: `النوع: ${artifact.kind === "document" ? "مستند" : artifact.kind === "presentation" ? "عرض" : "جدول"} • العنوان: ${artifact.title} • ${count} عنصر • مراجعة ${artifact.revision}` };
      },
    },
  ];
}

export const OFFICE_TOOL_NAMES = ["office_import", "office_export", "office_status"];
