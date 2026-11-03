/**
 * Typst tools (blueprint gap 2 — academic publishing).
 *
 * `typst_compile` typesets a workspace `.typ` document into a PDF next to it,
 * entirely on-device; `typst_template` scaffolds an academic skeleton so an
 * agent does not have to remember the preamble. Everything stays inside the
 * task workspace (path policy applies to both the source read and the PDF write).
 */
import fs from "node:fs";
import path from "node:path";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import { compileTypst } from "../typst/engine.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

/** Read an optional object of string values from tool args (null when absent/invalid). */
function strObj(args: Record<string, unknown>, key: string): Record<string, string> | null {
  const v = args[key];
  if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

export function createTypstTools(): Tool[] {
  return [
    {
      name: "typst_compile",
      description:
        "Compile a Typst document (.typ) in the workspace into a PDF using the local Typst engine (math, bibliography, figure numbering — academic-grade typesetting, no LaTeX install needed). The PDF is written next to the source with a .pdf extension and diagnostics (errors/warnings) are returned. Use typst_template first when starting a paper from scratch.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the .typ entry file." },
          inputs: { type: "object", description: "Optional key/values exposed to the document through sys.inputs.", additionalProperties: { type: "string" } },
        },
        required: ["path"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const rel = str(args, "path").trim();
        if (!rel) return { ok: false, content: "path is required" };
        if (!rel.toLowerCase().endsWith(".typ")) return { ok: false, content: "path must point to a .typ file" };
        let mainPath: string;
        try {
          mainPath = resolveRead(ctx.workspace, rel, false);
        } catch (err) {
          return { ok: false, content: `path: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (!fs.existsSync(mainPath)) return { ok: false, content: `not found: ${rel}` };
        const outPath = resolveWrite(ctx.workspace, mainPath.slice(0, -".typ".length) + ".pdf");
        const result = compileTypst({
          mainPath,
          workspaceRoot: ctx.workspace,
          inputs: strObj(args, "inputs") ?? undefined,
        });
        if (!result.ok || !result.pdf) {
          return { ok: false, content: [`typst compile failed for ${rel}:`, ...result.diagnostics].join("\n") };
        }
        fs.writeFileSync(outPath, result.pdf);
        const lines = [
          `pdf written: ${path.relative(ctx.workspace, outPath)} (${result.pdf.length} bytes, ${result.pages} page${result.pages === 1 ? "" : "s"})`,
        ];
        if (result.title) lines.push(`title: ${result.title}`);
        if (result.diagnostics.length > 0) lines.push(`warnings:\n${result.diagnostics.join("\n")}`);
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "typst_template",
      description:
        "Get a ready-to-fill Typst skeleton for an academic document (paper, thesis, report or homework): title block, abstract, sections, an equation, a figure and a bibliography slot. Save the returned source to a .typ file, fill it in, then compile with typst_compile.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["paper", "thesis", "report", "homework"], description: "Document preset. Default paper." },
          title: { type: "string", description: "Document title placeholder." },
          author: { type: "string", description: "Author line placeholder." },
        },
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const kind = str(args, "kind", "paper");
        const title = str(args, "title", "عنوان المستند") || "عنوان المستند";
        const author = str(args, "author", "المؤلف") || "المؤلف";
        const paper = [
          `#set document(title: "${title.replace(/"/g, '\\"')}", author: ("${author.replace(/"/g, '\\"')}"))`,
          `#set page(paper: "a4", margin: 2.5cm)`,
          `#set text(lang: "ar", size: 11pt) // بدّل الخط/اللغة عند الحاجة`,
          `#set heading(numbering: "1.1.")`,
          ``,
          `= ملخص`,
          `ملخص موجز لفكرة المستند ومنهجه ونتائجه.`,
          ``,
          `== مقدمة`,
          `السياق وأهمية الموضوع. @eq:main يربط الفكرة المركزية.`,
          ``,
          `== المنهج`,
          `#set math.equation(numbering: "1.")`,
          `$ E = m c^2 $ <eq:main>`,
          ``,
          `== النتائج`,
          `#figure(`,
          `  table(`,
          `    columns: 3,`,
          `    [*المؤشر*], [*قيمة مرجعية*], [*قيمتنا*],`,
          `    [أ], [1.00], [1.02],`,
          `    [ب], [2.00], [2.11],`,
          `  ),`,
          `  caption: [نتائج المقارنة],`,
          `) <tab:results>`,
          ``,
          `== الخلاصة`,
          `الاستنتاج وإشارة إلى @tab:results.`,
          ``,
          `// فعّل السطر التالي بعد إنشاء ملف المراجع refs.bib: #bibliography("refs.bib")`,
        ].join("\n");
        const thesis = [
          `#set document(title: "${title.replace(/"/g, '\\"')}", author: ("${author.replace(/"/g, '\\"')}"))`,
          `#set page(paper: "a4", margin: (x: 3cm, y: 2.5cm), numbering: "1")`,
          `#set text(lang: "ar", size: 12pt)`,
          `#set heading(numbering: "1.1.1.")`,
          `#outline(title: [الفهرس], depth: 2)`,
          `#pagebreak()`,
          ``,
          `= الفصل الأول: الإطار العام`,
          `== مشكلة الدراسة`,
          `...`,
          `== أسئلة الدراسة`,
          `...`,
          ``,
          `= الفصل الثاني: الإطار النظري`,
          `...`,
          ``,
          `= الفصل الثالث: المنهجية`,
          `...`,
          ``,
          `= الفصل الرابع: النتائج والمناقشة`,
          `...`,
          ``,
          `= الفصل الخامس: الخلاصة والتوصيات`,
          `...`,
          ``,
          `// فعّل السطر التالي بعد إنشاء ملف المراجع refs.bib: #bibliography("refs.bib")`,
        ].join("\n");
        const report = [
          `#set document(title: "${title.replace(/"/g, '\\"')}", author: ("${author.replace(/"/g, '\\"')}"))`,
          `#set page(paper: "a4", margin: 2cm)`,
          `#set text(lang: "ar", size: 11pt)`,
          `#set heading(numbering: "1.")`,
          ``,
          `= الهدف`,
          `ماذا يغطي هذا التقرير.`,
          ``,
          `= الملاحظات`,
          `- ملاحظة واحدة لكل بند.`,
          ``,
          `= المخاطر`,
          `#figure(`,
          `  table(columns: (auto, auto, auto), [*الخطر*], [*الأثر*], [*التخفيف*], [..], [..], [..]),`,
          `  caption: [سجل المخاطر],`,
          `)`,
          ``,
          `= الخطوات التالية`,
          `1. خطوة`,
          `2. خطوة`,
        ].join("\n");
        const homework = [
          `#set page(paper: "a4", margin: 2cm)`,
          `#set text(lang: "ar", size: 12pt)`,
          `#align(center)[*${title.replace(/"/g, '\\"')}* \\ ${author.replace(/"/g, '\\"')}]`,
          `#v(1em)`,
          ``,
          `== السؤال الأول`,
          `نص السؤال.`,
          ``,
          `الحل:`,
          `$ x^2 + 2x + 1 = (x+1)^2 $`,
          ``,
          `== السؤال الثاني`,
          `نص السؤال.`,
        ].join("\n");
        const source = kind === "thesis" ? thesis : kind === "report" ? report : kind === "homework" ? homework : paper;
        return { ok: true, content: source };
      },
    },
  ];
}
