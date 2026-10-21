/**
 * Office edit agent (O2): turns one instruction into a **minimal set of targeted
 * edits** for an existing DOCX/XLSX/PPTX, then applies them through the existing
 * studio round-trip (import → studio artifact → save → template-preserving
 * export). It never regenerates the document: only the cells, blocks, slides and
 * regions named by the ops change; every other part of the artifact passes
 * through untouched so the template, media and formatting survive.
 *
 * NOTICE: the implementation below is original Loam TypeScript. The overall
 * targeted-edit-over-round-trip architecture is referenced from the office
 * frontier / gap plan documents (docs/handoff); no third-party code, brand or
 * assets are used.
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { taskPath } from "../server/taskWorkspace.js";
import { readStudio, saveStudio, StudioError, type StudioArtifact, type DocumentBlock } from "../studio/store.js";
import { importStudio } from "../studio/import.js";
import { exportStudio } from "../studio/export.js";

export type OfficeEditOp =
  | { op: "set-title"; value: string }
  | { op: "set-cell"; address: string; value: string; sheet?: string }
  | { op: "replace-text"; find: string; replace: string; slide?: number }
  | { op: "set-slide-title"; slide: number; value: string }
  | { op: "set-slide-notes"; slide: number; value: string }
  | { op: "set-block-text"; block: number; value: string }
  | { op: "set-region-text"; label: string; value: string };

export type AppliedOp = { index: number; op: OfficeEditOp };
export type SkippedOp = { index: number; op: OfficeEditOp; reason: string };
export type ApplyResult = { artifact: StudioArtifact; applied: AppliedOp[]; skipped: SkippedOp[] };

/** Given the current artifact and the planned ops, return a NEW artifact with
 *  only the targeted elements changed plus a per-op disposition. Pure input. */
export type OfficeEditApplier = (artifact: StudioArtifact, ops: OfficeEditOp[]) => ApplyResult;

const isPlainBlock = (block: DocumentBlock) =>
  block.type === "paragraph" || block.type === "heading" || block.type === "bullet";

/* ------------------------------------------------------------------ *
 * Instruction → op planning (deterministic, no model in the loop)     *
 * ------------------------------------------------------------------ */

const QUOTE_PAIRS: Array<[string, string]> = [["«", "»"], ["\"", "\""], ["'", "'"]];

/** Extract quoted spans «…», "…" or '…' in order of appearance. */
export function quotedSpans(text: string): Array<{ text: string; start: number }> {
  const spans: Array<{ text: string; start: number }> = [];
  for (const [open, close] of QUOTE_PAIRS) {
    const regex = new RegExp(`${open}([^${open}${close}]*)${close}`, "gu");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) spans.push({ text: match[1]!, start: match.index });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Value after a directive: first quoted span if present, otherwise the
 *  remainder trimmed, keeping only what follows the LAST directive marker
 *  (to / إلى / = / : / → / ←). */
function valueOf(remainder: string): string {
  const spans = quotedSpans(remainder);
  if (spans.length) return spans[0]!.text.trim();
  const marker = /\b(?:to|إلى)\b|→|←|[:=]/g;
  let cut = -1;
  for (let match = marker.exec(remainder); match; match = marker.exec(remainder)) {
    cut = match.index + match[0].length;
    marker.lastIndex = cut;
  }
  return (cut >= 0 ? remainder.slice(cut) : remainder).replace(/^[\s:=→]+/u, "").trim().replace(/[\s.،]+$/u, "");
}

/** Remove the first two quoted spans from the clause so structural keywords of
 *  the *literal* instruction are matched, not the quoted payload. */
function withoutFirstQuotes(text: string, count: number): string {
  let out = text;
  for (let i = 0; i < count; i++) {
    const spans = quotedSpans(out);
    if (!spans.length) break;
    const first = spans[0]!;
    const open = QUOTE_PAIRS.find(([o]) => out.slice(first.start, first.start + o.length) === o);
    out = out.slice(0, first.start) + out.slice(first.start + (open ? open[0].length + first.text.length + (open[1]?.length ?? open[0].length) : 0));
  }
  return out;
}

/** Parse an A1 address like "B12" into 1-based row/column, or null. */
export function parseCellAddress(address: string): { row: number; column: number } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,3})$/i.exec(address.trim());
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { row: Number(match[2]), column };
}

export function columnLetters(column: number): string {
  let n = column, out = "";
  while (n > 0) { out = String.fromCharCode(65 + ((n - 1) % 26)) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

const SLIDE = "(?:slide|شريحة)";
const KEYWORD = "(?:replace|استبدل|بدّل|بدل)";

export interface OfficeEditDeps {
  importStudio?: typeof importStudio;
  readStudio?: typeof readStudio;
  saveStudio?: typeof saveStudio;
  exportStudio?: typeof exportStudio;
  applier?: OfficeEditApplier;
}

export interface EditPlan { ops: OfficeEditOp[]; error?: string; scopes: string[] }

/** Turn an instruction into ops given the current artifact's actual shape.
 *  Splitting on line/`;` allows multi-edit instructions in one call; each clause
 *  yields at most one op. All slide/paragraph/row numbers are 1-based. */
export function planOfficeEdits(instruction: string, artifact: StudioArtifact): EditPlan {
  const ops: OfficeEditOp[] = [];
  const scopes = new Set<string>();
  const clauses = instruction.split(/\n|;\s*/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const op = planClause(clause, artifact);
    if (!op) continue;
    if (typeof op === "string") return { ops: [], error: op, scopes: [...scopes] };
    ops.push(op);
    scopes.add(op.op);
  }
  if (!ops.length) {
    return { ops, scopes: [...scopes], error: "تعذر استخراج تعديل دقيق من التعليمة. الصيغة المدعومة: replace \"old\" with \"new\"، set cell B2 to \"value\" [in Sheet1]، set slide 2 title to \"value\"، slide 2 notes to \"value\"، paragraph 3 to \"value\"، set document title to \"value\"، header \"value\" to \"value\"." };
  }
  return { ops, scopes: [...scopes] };
}

/** Match one clause to one op. Returns a string for user-facing failures. */
function planClause(clause: string, artifact: StudioArtifact): OfficeEditOp | string | null {
  const slideNum = (text: string): number | undefined => {
    const slideMatch = new RegExp(`${SLIDE}\\s+(\\d{1,3})`, "i").exec(withoutFirstQuotes(text, 2));
    return slideMatch ? Number(slideMatch[1]) : undefined;
  };
  const spans = quotedSpans(clause);

  // 1. replace-text: replace X with/by/بـ Y (also Arabic بدّل).
  const replaceRegex = new RegExp(`${KEYWORD}\\s+(?:${SLIDE}\\s+\\d{1,3}\\s+)?`, "i");
  if (replaceRegex.test(clause)) {
    const slide = slideNum(clause);
    if (spans.length >= 2) {
      return { op: "replace-text", find: spans[0]!.text, replace: spans[1]!.text, ...(slide !== undefined ? { slide } : {}) };
    }
    const literal = new RegExp(`${KEYWORD}\\s+(.+?)\\s+(?:with|by|بـ?|ב)\\s+`, "i").exec(clause);
    if (literal && literal[1]) return { op: "replace-text", find: literal[1].trim(), replace: valueOf(clause.slice(literal.index + literal[0].length)), ...(slide !== undefined ? { slide } : {}) };
  }

  // 2. set-cell: set/write cell B2 to "…" (optionally `in Sheet1`), or Sheet1 B2.
  const cellRegex = /(?:cell|خلية)\s+([A-Z]{1,3}[1-9]\d{0,3})/i;
  const cellMatch = cellRegex.exec(clause);
  if (cellMatch) {
    const sheetMatch = /\bin\s+([^\s«"',;.]+)|(?:ورقة|sheet)\s+([^\s«"',;.«»"]+)\s*(?:في)?/i.exec(clause);
    const value = spans.length ? spans[spans.length - 1]!.text : valueOf(clause.slice(cellMatch.index + cellMatch[0].length));
    return { op: "set-cell", address: cellMatch[1]!.toUpperCase(), value, ...(sheetMatch1(sheetMatch) ? { sheet: sheetMatch1(sheetMatch) } : {}) };
  }

  // 3. set-slide-title: slide 2 title to "…" / title of slide 2 / عنوان الشريحة 2.
  const slide = slideNum(clause);
  if (slide !== undefined && /\b(?:title|عنوان)\b/i.test(clause) && !/(?:notes|ملاحظات)/i.test(clause)) {
    return { op: "set-slide-title", slide, value: valueOf(clause) };
  }

  // 4. set-slide-notes.
  if (slide !== undefined && /\b(?:notes?|ملاحظات)\b/i.test(clause)) {
    return { op: "set-slide-notes", slide, value: valueOf(clause) };
  }

  // 5. set-block-text: paragraph 3 to "…", الفقرة 5.
  const blockMatch = /(?:paragraph|فقرة)\s+(\d{1,4})/i.exec(clause);
  if (blockMatch) return { op: "set-block-text", block: Number(blockMatch[1]), value: valueOf(clause) };

  // 6. set-region-text: header/footer (or ترويسة/تذييل) text to "…". Match the
  //    artifact's actual region labels; fall back to the region kind label.
  if (/\b(?:header|footer)\b|ترويس|تذييل/i.test(clause) && !/(?:slide|شريحة)/i.test(clause)) {
    const regions = artifact.kind === "document" ? artifact.content.regions ?? [] : [];
    const wantHeader = /header|ترويس/i.test(clause);
    const wantFooter = /footer|تذييل/i.test(clause);
    const region = regions.find((r) => (wantHeader ? r.kind === "header" : wantFooter ? r.kind === "footer" : false));
    const label = region?.label ?? (wantHeader ? "header" : "footer");
    if (regions.length === 0) return `لا توجد ترويسة أو تذييل قابلة للتحرير في هذا المستند.`;
    return { op: "set-region-text", label, value: valueOf(clause) };
  }

  // 7. set-title: document title / عنوان المستند / bare "title to" when no slide keyword.
  if (!/(?:slide|شريحة)\s+\d/i.test(clause) && /\b(?:title|عنوان)\b/i.test(clause)) {
    return { op: "set-title", value: valueOf(clause) };
  }
  return null;
}

function sheetMatch1(match: RegExpExecArray | null): string | undefined {
  const value = match?.[1] ?? match?.[2];
  return value ? value.replace(/["']/g, "") : undefined;
}

/* ------------------------------------------------------------------ *
 * Default applier: clone once, mutate only named slots                *
 * ------------------------------------------------------------------ */

export const applyOfficeEdits: OfficeEditApplier = (artifact, ops) => {
  const next = structuredClone(artifact) as StudioArtifact;
  const applied: AppliedOp[] = [];
  const skipped: SkippedOp[] = [];
  ops.forEach((op, index) => {
    const reason = applyOne(next, op);
    if (reason === null) applied.push({ index, op });
    else skipped.push({ index, op, reason });
  });
  return { artifact: next, applied, skipped };
};

/** Apply one op in place on the cloned artifact. Return null on success. */
function applyOne(artifact: StudioArtifact, op: OfficeEditOp): string | null {
  switch (op.op) {
    case "set-title":
      artifact.title = op.value;
      return null;
    case "set-cell": {
      if (artifact.kind !== "spreadsheet") return "cells exist only in spreadsheets";
      const sheet = op.sheet
        ? artifact.content.sheets.find((s) => s.name.toLowerCase() === op.sheet!.toLowerCase())
        : artifact.content.sheets[0];
      if (!sheet) return `sheet not found: ${op.sheet}`;
      const position = parseCellAddress(op.address);
      if (!position) return `invalid cell address: ${op.address}`;
      if (position.row > sheet.cells.length || position.column > (sheet.cells[0]?.length ?? 0)) {
        return `cell ${op.address} is outside the existing grid`;
      }
      sheet.cells[position.row - 1]![position.column - 1] = op.value;
      return null;
    }
    case "replace-text": {
      if (op.find === op.replace) return "find and replace text are identical";
      let touched = false;
      if (artifact.kind === "document") {
        for (const block of artifact.content.blocks) {
          touched = replaceInto(block, op) || touched;
        }
        for (const region of artifact.content.regions ?? []) {
          if (region.text.includes(op.find)) { region.text = region.text.split(op.find).join(op.replace); touched = true; }
        }
      } else if (artifact.kind === "presentation") {
        const slides = op.slide === undefined ? artifact.content.slides : [artifact.content.slides[op.slide - 1]];
        if (op.slide !== undefined && !slides[0]) return `slide ${op.slide} does not exist`;
        for (const slide of slides) {
          if (!slide) continue;
          if (slide.title.includes(op.find)) { slide.title = slide.title.split(op.find).join(op.replace); touched = true; }
          if (slide.body.includes(op.find)) { slide.body = slide.body.split(op.find).join(op.replace); touched = true; }
          for (const box of slide.textBoxes ?? []) {
            const boxText = typeof box.text === "string" ? box.text : "";
            if (boxText.includes(op.find)) { box.text = boxText.split(op.find).join(op.replace); touched = true; }
          }
        }
      } else {
        for (const sheet of artifact.content.sheets) {
          if (op.slide !== undefined && sheet.sourceIndex !== op.slide - 1) continue;
          for (const row of sheet.cells) {
            for (let c = 0; c < row.length; c++) {
              const text = row[c] ?? "";
              if (text.includes(op.find)) { row[c] = text.split(op.find).join(op.replace); touched = true; }
            }
          }
        }
      }
      return touched ? null : `text not found: ${op.find}`;
    }
    case "set-slide-title": {
      if (artifact.kind !== "presentation") return "slides exist only in presentations";
      const slide = artifact.content.slides[op.slide - 1];
      if (!slide) return `slide ${op.slide} does not exist`;
      slide.title = op.value;
      return null;
    }
    case "set-slide-notes": {
      if (artifact.kind !== "presentation") return "slides exist only in presentations";
      const slide = artifact.content.slides[op.slide - 1];
      if (!slide) return `slide ${op.slide} does not exist`;
      slide.notes = op.value;
      return null;
    }
    case "set-block-text": {
      if (artifact.kind !== "document") return "paragraphs exist only in documents";
      const block = artifact.content.blocks[op.block - 1];
      if (!block) return `paragraph ${op.block} does not exist`;
      if (!isPlainBlock(block)) return `block ${op.block} is a ${block.type} block, not plain text`;
      block.text = op.value;
      block.segments = undefined;
      return null;
    }
    case "set-region-text": {
      if (artifact.kind !== "document") return "regions exist only in documents";
      const region = artifact.content.regions?.find((r) => r.label === op.label || r.label === op.label.toLowerCase());
      if (!region) return `region not found: ${op.label}`;
      region.text = op.value;
      return null;
    }
  }
}

/** Replace every occurrence inside one plain block's text (and segments when present). */
function replaceInto(block: DocumentBlock, op: Extract<OfficeEditOp, { op: "replace-text" }>): boolean {
  if (!isPlainBlock(block)) {
    if (block.type === "table") {
      let touched = false;
      block.rows = block.rows.map((row) => row.map((cell) => {
        if (cell.includes(op.find)) touched = true;
        return cell.split(op.find).join(op.replace);
      }));
      return touched;
    }
    return false;
  }
  if (!block.text.includes(op.find)) return false;
  block.text = block.text.split(op.find).join(op.replace);
  if (block.segments) block.segments = block.segments.map((segment) => ({ ...segment, text: segment.text.split(op.find).join(op.replace) }));
  return true;
}

/* ------------------------------------------------------------------ *
 * Tool: office_edit { path, instruction }                             *
 * ------------------------------------------------------------------ */

const kindForExtension = (extension: string): StudioArtifact["kind"] | null =>
  extension === "docx" ? "document" : extension === "xlsx" ? "spreadsheet" : extension === "pptx" ? "presentation" : null;

const OP_GRAMMAR = `الصيغة المدعومة: ‹replace "old" with "new"›، ‹set cell B2 to "…"[ in Sheet1]›، ‹set slide 2 title to "…"›، ‹slide 2 notes to "…"›، ‹paragraph 3 to "…"›، ‹set document title to "…"›، ‹header "…" to "…"›.`;

export function createOfficeEditTools(deps: OfficeEditDeps = {}): Tool[] {
  const doImport = deps.importStudio ?? importStudio;
  const doRead = deps.readStudio ?? readStudio;
  const doSave = deps.saveStudio ?? saveStudio;
  const doExport = deps.exportStudio ?? exportStudio;
  const doApply = deps.applier ?? applyOfficeEdits;
  return [
    {
      name: "office_edit",
      description: "طبّق تعليمة تحرير دقيقة على ملف أوفيس موجود (DOCX/XLSX/PPTX) في مساحة المهمة. يحوّل التعليمة إلى قائمة تعديلات هدفة (خلية، تخصيص نص، عنوان شريحة…) ويطبّقها عبر دورة الاستوديو مع المحافظة على بقية الملف. يُعاد كتابة الملف الأصلي مكانه.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "المسار النسبي للملف في مساحة المهمة (مثل uploads/report.docx)" },
          instruction: { type: "string", description: "تعليمة واحدة أو عدة تعليمات مفصولة بفاصلة منقوطة، مثل: replace «Alpha» with «Beta»; set cell B2 to «42»" },
        },
        required: ["path", "instruction"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const rel = str(args, "path").trim();
        const instruction = str(args, "instruction").trim();
        if (!rel) return { ok: false, content: "المعامل path مطلوب." };
        if (!instruction) return { ok: false, content: "المعامل instruction مطلوب." };
        const extension = path.extname(rel).toLowerCase().slice(1);
        const kind = kindForExtension(extension);
        if (!kind) return { ok: false, content: "الأدوات تدعم DOCX وXLSX وPPTX فقط." };
        let file: string;
        try { file = taskPath(ctx.workspace, rel); } catch (error) { return { ok: false, content: `مسار غير مسموح: ${error instanceof Error ? error.message : String(error)}` }; }
        try {
          let artifact = doRead(ctx.workspace);
          if (!artifact || artifact.kind !== kind) {
            if (!fs.existsSync(file)) return { ok: false, content: `الملف غير موجود: ${rel}` };
            artifact = await doImport(ctx.workspace, fs.readFileSync(file), path.basename(rel), 0);
          }
          const plan = planOfficeEdits(instruction, artifact);
          if (plan.error && !plan.ops.length) return { ok: false, content: `تعذر التخطيط: ${plan.error}` };
          const result = doApply(artifact, plan.ops);
          if (!result.applied.length) {
            const reasons = result.skipped.map((s) => `— ${s.reason}`).join("\n");
            return { ok: false, content: `لم يُطبَّق أي تعديل.\n${reasons || plan.error || OP_GRAMMAR}` };
          }
          const saved = doSave(ctx.workspace, result.artifact, artifact.revision);
          const output = await doExport(saved, ctx.workspace);
          fs.writeFileSync(file, output.buffer);
          const skipped = result.skipped.length ? ` • تخطّي: ${result.skipped.map((s) => s.reason).join("؛ ")}` : "";
          return { ok: true, content: `طُبِّق ${result.applied.length} تعديلًا هدفًا على ${rel} (${output.filename === path.basename(rel) ? "نفس الملف" : output.filename}) — المراجعة الآن ${saved.revision} وبقية الملف كما هو.${skipped}` };
        } catch (error) {
          if (error instanceof StudioError) return { ok: false, content: `فشل التعديل: ${error.message}` };
          return { ok: false, content: `فشل التعديل: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}

export const OFFICE_EDIT_TOOL_NAMES = ["office_edit"];
