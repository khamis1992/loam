/** DOCX workspace editing: render a task .docx into editable rich-text HTML and turn the
 *  edited HTML back into a .docx, reusing the studio word import/export round trip
 *  (office_import / office_export logic) without touching the task's live studio state. */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import type JSZip from "jszip";
import type { DocumentBlock, DocumentRegion, InlineSegment } from "../../studio/store.js";
import { StudioError, validateStudio, type StudioArtifact } from "../../studio/store.js";
import { exportStudio } from "../../studio/export.js";
import { importWordBlocks, importWordRegions, children } from "../../studio/word-import.js";
import { loadImport } from "../../studio/import.js";
import { safeZip, part, escapeXml, xml as strictXml } from "../../studio/ooxml.js";
import { taskPath } from "../taskWorkspace.js";

export class DocFileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function failDoc(message: string, status = 400): never { throw new DocFileError(message, status); }

type DocumentArtifact = Extract<StudioArtifact, { kind: "document" }>;

/** Opaque save token the editor echoes back in its HTML payload: which import snapshot the
 *  edit is based on and the file mtime the editor last observed. */
export function markerLine(session: string, mtimeMs: number): string {
  return `<!-- doc-session ${session} ${mtimeMs} -->`;
}
export function parseMarker(html: string): { session: string; mtimeMs: number } | null {
  const match = /^<!--\s*doc-session\s+([a-f0-9-]{36})\s+(\d+(?:\.\d+)?)\s*-->\s*/.exec(html);
  if (!match) return null;
  const session = match[1]!;
  return snake(session) ? { session, mtimeMs: Number(match[2]) } : null;
}
const snake = (value: string): boolean => /^[a-f0-9-]{36}$/.test(value);
export function stripMarker(html: string): string {
  return html.replace(/^<!--\s*doc-session\s+[a-f0-9-]{36}\s+\d+\s*-->\s*/, "");
}

export function isDocxPath(rel: string): boolean {
  return /\.docx$/i.test(rel);
}

function docTitle(rel: string): string {
  return path.basename(rel, path.extname(rel)).slice(0, 200) || "Document";
}

export interface WorkspaceDocMeta {
  mtimeMs: number;
  size: number;
  name: string;
}

export function docFileMeta(workspace: string, rel: string): WorkspaceDocMeta {
  if (!isDocxPath(rel)) failDoc("Only DOCX files are supported in the document workspace");
  const file = taskPath(workspace, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) failDoc("File not found", 404);
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size, name: docTitle(rel) };
}

/** Documents above 2000 paragraphs are outside the studio's import bounds. */
function assertImportBounds(blocks: DocumentBlock[]): void {
  if (blocks.length > 2000) failDoc("Document exceeds 2000 paragraphs");
}

/** Keep the `.loam/imports` shadow store bounded: prune snapshots no studio state references. */
function pruneShadowImports(workspace: string): void {
  try {
    const dir = taskPath(workspace, ".loam/imports");
    if (!fs.existsSync(dir)) return;
    let referenced = "";
    try {
      referenced = String((JSON.parse(fs.readFileSync(taskPath(workspace, ".loam/studio.json"), "utf8")) as { sourceId?: unknown }).sourceId ?? "");
    } catch { /* no saved studio state */ }
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    let kept = 0;
    for (const name of names) {
      const id = name.slice(0, -5);
      const zipFile = path.join(dir, `${id}.zip`);
      if (!/^[a-f0-9-]{36}$/.test(id) || id === referenced) continue;
      if (!fs.existsSync(zipFile)) continue;
      kept++;
      if (kept > 50 || fs.statSync(zipFile).mtimeMs < cutoff) {
        fs.rmSync(zipFile, { force: true });
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch { /* cleanup is best effort */ }
}

/** Persist the original bytes + baseline for the round trip, reusing the studio's
 *  `.loam/imports` layout so `loadImport` reads it back unchanged. Returns the session id. */
function persistShadowImport(workspace: string, buffer: Buffer, build: (id: string) => DocumentArtifact): string {
  const id = randomUUID();
  const artifact = build(id);
  const source = taskPath(workspace, `.loam/imports/${id}.zip`);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, buffer, { flag: "wx" });
  const manifest = taskPath(workspace, `.loam/imports/${id}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ extension: "docx", artifact, parts: ["word/document.xml"] }), { flag: "wx" });
  return id;
}

export interface LoadWorkspaceDocResult {
  html: string;
  session: string;
  mtimeMs: number;
  size: number;
  name: string;
  warnings: string[];
  /** False when the original document contains elements outside the editable text flow. */
  editable: boolean;
}

export async function loadWorkspaceDoc(workspace: string, rel: string): Promise<LoadWorkspaceDocResult> {
  const meta = docFileMeta(workspace, rel);
  const buffer = fs.readFileSync(taskPath(workspace, rel));
  let zip: JSZip;
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    zip = await safeZip(buffer);
    doc = await part(zip, "word/document.xml");
  } catch (error) {
    if (error instanceof StudioError) failDoc(error.message, 400);
    throw error;
  }
  const blocks = await importWordBlocks(zip, doc);
  assertImportBounds(blocks);
  const regions = (await importWordRegions(zip, doc, blocks)) ?? [];
  const bodyNodes = children((doc as any).documentElement, "body")[0] ?? null;
  const warning = bodyNodes ? importedWarning(bodyNodes, blocks, regions) : null;
  const session = persistShadowImport(workspace, buffer, (id) => ({
    kind: "document",
    title: meta.name,
    revision: 0,
    sourceId: id,
    warnings: ["معاينة مبسطة قابلة للتحرير. تبقى العناصر غير المعروضة محفوظة في الملف الأصلي عند التصدير."],
    content: { blocks, ...(regions.length ? { regions } : {}) },
  }));
  pruneShadowImports(workspace);
  const allHtml = markerLine(session, meta.mtimeMs) + "\n" + blocksToHtml(blocks, regions);
  return {
    html: allHtml,
    session,
    mtimeMs: meta.mtimeMs,
    size: meta.size,
    name: meta.name,
    warnings: warning ? [warning] : [],
    editable: warning === null,
  };
}

/** Body nodes the studio text flow cannot model: complex tables, legacy drawings, and any
 *  text block whose source node is not a simple <w:p> (the word round trip refuses those). */
function importedWarning(body: any, blocks: DocumentBlock[], regions: DocumentRegion[]): string | null {
  const used = new Set<number>();
  const nodes = new Map<number, any>();
  children(body).forEach((node, index) => {
    nodes.set(index, node);
    if (node.localName === "sectPr") return;
    used.add(index);
  });
  for (const block of blocks) {
    if (block.sourceNode === undefined) continue;
    const node = nodes.get(block.sourceNode);
    if (!node) return blockWarning;
    if (node.localName !== "p" && block.type !== "table" && block.type !== "stats" && block.type !== "image") return blockWarning;
    used.delete(block.sourceNode);
  }
  for (const region of regions) if (region.node !== undefined) used.delete(region.node);
  const uncovered = used.size;
  return uncovered > 0
    ? `بعض عناصر المستند (${uncovered}) غير مدعومة للتحرير؛ سيعرض المستند نصّه فقط والتغيرات غير المعروضة ستفقد عند الحفظ.`
    : null;
}

const blockWarning = "بعض عناصر المستند غير مدعومة للتحرير (جداول معقدة أو رسم متقدم)؛ افتح الملف عبر استوديو المهمة لتعديله أو احفظ نسخة نصية.";

export interface WorkspaceDocSaveResult {
  ok: true;
  marker: string;
  mtimeMs: number;
  size: number;
}

/** Convert the edited HTML back into a .docx and write it into the task file atomically. */
export async function saveWorkspaceDoc(workspace: string, rel: string, html: string): Promise<WorkspaceDocSaveResult> {
  const meta = docFileMeta(workspace, rel);
  const marker = parseMarker(html);
  if (!marker) failDoc("Save payload is missing its doc-session marker; reload the document before saving");
  if (fs.statSync(taskPath(workspace, rel)).mtimeMs !== marker.mtimeMs) {
    failDoc("الملف تغيّر على القرص منذ فتح المحرر — أعد التحميل قبل الحفظ", 409);
  }
  let baseline;
  try {
    baseline = loadImport(workspace, marker.session);
  } catch (error) {
    if (error instanceof StudioError) failDoc("انتهت جلسة التحرير — أعد فتح المستند ثم احفظ مرة أخرى", 409);
    throw error;
  }
  if (baseline.manifest.artifact?.kind !== "document") failDoc("جلسة تحرير غير متوافقة — أعد فتح المستند", 409);
  const baselineDoc = baseline.manifest.artifact as DocumentArtifact;

  const edited = htmlToBlocks(stripMarker(html), baselineDoc);
  const candidate: DocumentArtifact = {
    kind: "document",
    title: meta.name,
    revision: 1,
    sourceId: marker.session,
    ...(baselineDoc.warnings ? { warnings: baselineDoc.warnings } : {}),
    content: { blocks: edited, ...(baselineDoc.content.regions ? { regions: baselineDoc.content.regions } : {}) },
  };
  const clean = validateStudio(candidate) as DocumentArtifact;
  const output = await exportStudio(clean, workspace);
  const file = taskPath(workspace, rel);
  const temporary = `${file}-${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, output.buffer, { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  const stat = fs.statSync(file);
  return { ok: true, marker: markerLine(marker.session, stat.mtimeMs), mtimeMs: stat.mtimeMs, size: stat.size };
}

/* ---------------- HTML rendering (blocks → editor html) ---------------- */

function htmlStyles(block: DocumentBlock): string {
  const parts: string[] = [];
  if (block.style) {
    if (block.style.fontFamily) parts.push(`font-family:${block.style.fontFamily}`);
    if (block.style.fontSize) parts.push(`font-size:${Number(block.style.fontSize) || 14}px`);
    if (block.style.color) parts.push(`color:${block.style.color}`);
    if (block.style.alignment) parts.push(`text-align:${block.style.alignment}`);
  }
  return parts.join(";");
}

const esc = (value: string): string => escapeXml(value);
const cellHtml = (cell: string): string => esc(cell).replace(/\n/g, "<br/>");

function blockTextHtml(block: DocumentBlock): string {
  if (block.segments?.length) {
    let html = "";
    for (const segment of block.segments) {
      const body = cellHtml(segment.text);
      const first = segment.bold ? `<strong>${body}</strong>` : body;
      const emph = segment.italic ? `<em>${first}</em>` : first;
      html += segment.underline ? `<u>${emph}</u>` : emph;
    }
    return html;
  }
  const body = cellHtml(block.text);
  if (block.bold) return `<strong>${body}</strong>`;
  if (block.italic) return `<em>${body}</em>`;
  return body;
}

function attrSource(block: DocumentBlock): string {
  return block.sourceNode !== undefined ? ` data-s="${block.sourceNode}"` : "";
}

export function blocksToHtml(blocks: DocumentBlock[], regions: DocumentRegion[]): string {
  const lines: string[] = [];
  let listOpen = false;
  const closeList = (): void => { if (listOpen) { lines.push("</ul>"); listOpen = false; } };
  for (const block of blocks) {
    const style = htmlStyles(block);
    const styleHtml = style ? ` style="${esc(style)}"` : "";
    if (block.type === "bullet") {
      if (!listOpen) { lines.push("<ul>"); listOpen = true; }
      lines.push(`<li${attrSource(block)}${styleHtml}>${blockTextHtml(block)}</li>`);
      continue;
    }
    closeList();
    if (block.type === "heading") {
      lines.push(`<h1${attrSource(block)}${styleHtml}>${blockTextHtml(block)}</h1>`);
    } else if (block.type === "paragraph") {
      lines.push(`<p${attrSource(block)}${styleHtml}>${blockTextHtml(block)}</p>`);
    } else if (block.type === "table") {
      const header = `<tr>${block.columns.map((cell) => `<td>${cellHtml(cell)}</td>`).join("")}</tr>`;
      const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${cellHtml(cell)}</td>`).join("")}</tr>`);
      lines.push(`<table${attrSource(block)} data-type="table" class="loam-doc-table">${header}${rows.join("")}</table>`);
    } else if (block.type === "stats") {
      const cells = block.items.map((item) =>
        `<td data-value="${esc(item.value)}" data-label="${esc(item.label)}" data-tone="${item.tone}">${esc(item.value)}<span class="loam-stat-label">${esc(item.label)}</span></td>`);
      lines.push(`<table${attrSource(block)} data-type="stats" class="loam-doc-stats"><tr>${cells.join("")}</tr></table>`);
    } else if (block.type === "image") {
      lines.push(`<img${attrSource(block)} data-type="image" src="${esc(block.src)}" alt="${esc(block.alt)}"/>`);
    }
  }
  closeList();
  return lines.join("\n");
}

/* ---------------- HTML parsing (edited html → blocks) ---------------- */

interface PendingFlags { bold?: boolean; italic?: boolean; underline?: boolean }

function styleEntries(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index < 1) continue;
    out[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return out;
}

function inlineSegmentFlags(entry: PendingFlags): Record<string, unknown> | null {
  const clean: Record<string, unknown> = {};
  if (entry.bold) clean.bold = true;
  if (entry.italic) clean.italic = true;
  if (entry.underline) clean.underline = true;
  return Object.keys(clean).length ? clean : null;
}

function mergeSegments(list:InlineSegment[]):InlineSegment[]{
  const merged: InlineSegment[] = [];
  for (const segment of list) {
    if (!segment.text) continue;
    const last = merged[merged.length - 1];
    if (last && JSON.stringify([last.bold ?? null, last.italic ?? null, last.underline ?? null]) === JSON.stringify([segment.bold ?? null, segment.italic ?? null, segment.underline ?? null])) {
      last.text += segment.text;
    } else merged.push({ ...segment });
  }
  return merged;
}

/** Inline runs of a block element: bold/italic/underline recognized on strong/b, em/i, u and
 *  matching span styles; <br> becomes a newline; anything else passes through as text. */
function collectSegments(node: any, flags: PendingFlags, out: InlineSegment[]): void {
  for (const child of Array.from(node.childNodes as ArrayLike<any>)) {
    if (!child) continue;
    if (child.nodeType === 3) {
      const text = String(child.nodeValue ?? "").replace(/\u00a0/g, " ");
      if (!text) continue;
      const segment: Record<string, unknown> = { text };
      const styled = inlineSegmentFlags(flags);
      if (styled) Object.assign(segment, styled);
      out.push(segment as InlineSegment);
    } else if (child.nodeType === 1) {
      const tag = String(child.localName ?? "").toLowerCase();
      const next = { ...flags };
      let descend = true;
      if (tag === "br") { out.push({ text: "\n" }); descend = false; }
      else if (tag === "strong" || tag === "b") next.bold = true;
      else if (tag === "em" || tag === "i") next.italic = true;
      else if (tag === "u") next.underline = true;
      else if (tag === "span" || tag === "font") {
        const style = styleEntries(child.getAttribute ? child.getAttribute("style") : "");
        const weight = style["font-weight"] ?? "";
        if (/^(bold|[5-9]\d\d?)$/i.test(weight)) next.bold = true;
        if (style["font-style"] === "italic") next.italic = true;
        if ((style["text-decoration"] ?? "").includes("underline")) next.underline = true;
      }
      else if (["img", "table", "script", "style", "ul", "ol", "menu"].includes(tag)) descend = false;
      if (descend) collectSegments(child, next, out);
    }
  }
}

function cellText(node: any): string {
  const paragraphs = Array.from(node.childNodes as ArrayLike<any>).filter((n: any) => n.nodeType === 1);
  if (!paragraphs.length) {
    const out: InlineSegment[] = [];
    collectSegments(node, {}, out);
    return mergeSegments(out).map((segment) => segment.text).join("");
  }
  const lines: string[] = [];
  for (const paragraph of paragraphs as any[]) {
    const out: InlineSegment[] = [];
    collectSegments(paragraph, {}, out);
    lines.push(mergeSegments(out).map((segment) => segment.text).join(""));
  }
  return lines.join("\n");
}

/** Mirror importWordBlocks' segmentation rules: a uniform bold/italic paragraph carries
 *  block-level flags and no segments, so the word round trip keeps using its cheaper
 *  patchText path; multi-run or underlined paragraphs keep explicit segments. */
function foldUniform(block: DocumentBlock): void {
  const segments = block.segments;
  if (!segments?.length) return;
  if (segments.length === 1 && !segments[0]!.underline) {
    const segment = segments[0]!;
    if (segment.bold) block.bold = true;
    if (segment.italic) block.italic = true;
    delete block.segments;
  }
}

export function htmlToBlocks(payload: string, baseline: DocumentArtifact): DocumentBlock[] {
  const trimmed = payload.trim();
  if (!trimmed) failDoc("المحرر فارغ — لا يمكن الحفظ");
  let dom: any;
  try {
    // The editor emits a block fragment; a single root keeps the XML parser well-defined.
    dom = strictXml(`<loam-doc xmlns="loam-doc-ns">${trimmed}</loam-doc>`);
  } catch (error) {
    if (error instanceof StudioError) failDoc("تعذر قراءة تعديلات المستند");
    throw error;
  }
  const body = dom?.documentElement ?? null;
  if (!body) failDoc("تعذر قراءة تعديلات المستند");
  const bySource = new Map<number, DocumentBlock>();
  for (const block of baseline.content.blocks) if (block.sourceNode !== undefined && !bySource.has(block.sourceNode)) bySource.set(block.sourceNode, block);
  const blocks: DocumentBlock[] = [];
  const walk = (node: any, type?: "paragraph" | "heading" | "bullet"): void => {
    if (node.nodeType !== 1) return;
    const tag = String(node.localName ?? "").toLowerCase();
    if (tag === "script" || tag === "style") return;
    const source = sourceOf(node, bySource);
    if (type === undefined && (tag === "ul" || tag === "ol" || tag === "menu")) {
      for (const item of childrenOf(node, "li")) walk(item, "bullet");
      return;
    }
    if (tag === "table") {
      const kind = String(node.getAttribute("data-type") ?? "table");
      if (kind === "stats") blocks.push(statsBlock(node, source));
      else blocks.push(tableBlock(node, source));
      return;
    }
    if (tag === "img") { blocks.push(imageBlock(node, source)); return; }
    const blockType: "paragraph" | "heading" | "bullet" = type ?? (tag === "li" ? "bullet" : /^h[1-6]$/.test(tag) ? "heading" : "paragraph");
    {
      const out: InlineSegment[] = [];
      collectSegments(node, {}, out);
      const segments = mergeSegments(out);
      const block: DocumentBlock = { type: blockType, text: segments.map((segment) => segment.text).join("") };
      if (source?.kind === "text") block.sourceNode = source.index;
      if (segments.length) block.segments = segments;
      styleReadBack(node, block);
      foldUniform(block);
      blocks.push(block);
    }
  };
  for (const node of Array.from(body.childNodes as ArrayLike<any>)) walk(node);
  return blocks;
}

function childrenOf(node: any, name: string): any[] {
  return Array.from(node.childNodes as ArrayLike<any>).filter((n: any) => n.nodeType === 1 && String(n.localName ?? "").toLowerCase() === name);
}

function sourceOf(node: any, bySource: Map<number, DocumentBlock>): { kind: "text" | "rich"; index: number } | null {
  const raw = node.getAttribute ? node.getAttribute("data-s") : null;
  if (raw === null) return null;
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index < 0 || !bySource.has(index)) return null;
  const baseline = bySource.get(index)!;
  const isRich = baseline.type === "table" || baseline.type === "stats" || baseline.type === "image";
  const tag = String(node.localName ?? "").toLowerCase();
  const isRichTag = tag === "table" || tag === "img";
  if (isRichTag !== isRich) return null;
  return { kind: isRich ? "rich" : "text", index };
}

function styleReadBack(node: any, block: DocumentBlock): void {
  const style = styleEntries(node.getAttribute ? node.getAttribute("style") : "");
  if (!Object.keys(style).length) return;
  const read: Record<string, string | number | boolean> = {};
  if (style["font-family"]) read.fontFamily = style["font-family"].replace(/["']/g, "").slice(0, 100);
  if (style["font-size"]) {
    const px = Number(/^(\d+(?:\.\d+)?)px$/.exec(style["font-size"])?.[1] ?? NaN);
    if (Number.isFinite(px) && px >= 1) read.fontSize = px;
  }
  if (style.color && /^#[a-f0-9]{6}$/i.test(style.color)) read.color = style.color.toLowerCase();
  if (style["text-align"] && /^(left|right|center|justify|start|end)$/.test(style["text-align"])) read.alignment = style["text-align"];
  if (Object.keys(read).length) block.style = read as DocumentBlock["style"];
}

function tableBlock(node: any, source: { kind: string; index: number } | null): DocumentBlock & { type: "table" } {
  const grid: string[][] = [];
  for (const row of childrenOf(node, "tr")) {
    grid.push(childrenOf(row, "td").concat(childrenOf(row, "th")).map((cell) => truncate(cellText(cell), 1000)));
  }
  if (!grid.length) failDoc("الجدول فارغ");
  const columns = grid[0]!.slice(0, 6);
  const rows = grid.slice(1).map((row) => row.slice(0, columns.length));
  const block = { type: "table" as const, text: "", columns, rows: rows.map((row) => row || []) };
  if (source?.kind === "rich" && Number.isSafeInteger(source.index)) (block as any).sourceNode = source.index;
  return block;
}

function statsBlock(node: any, source: { kind: string; index: number } | null): DocumentBlock & { type: "stats" } {
  const row = childrenOf(node, "tr")[0];
  const cells = childrenOf(row, "td");
  if (!cells.length) failDoc("بطاقة الإحصاءات فارغة");
  const items = cells.slice(0, 4).map((cell): { value: string; label: string; tone: "teal" | "blue" | "amber" } => {
    const attribute = (name: string): string => String(cell.getAttribute?.(name) ?? "");
    const value = attribute("data-value") || cellText(cell) || "0";
    const tone = attribute("data-tone");
    return {
      value: value.slice(0, 40),
      label: attribute("data-label").slice(0, 120),
      tone: tone === "blue" || tone === "amber" ? tone : "teal",
    };
  });
  const block = { type: "stats" as const, text: "", items };
  if (source?.kind === "rich" && Number.isSafeInteger(source.index)) (block as any).sourceNode = source.index;
  return block;
}

function imageBlock(node: any, source: { kind: string; index: number } | null): DocumentBlock & { type: "image" } {
  const src = String(node.getAttribute("src") ?? "");
  const bytes = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  const signature = !src.startsWith("data:image/png")
    ? bytes[0] === 255 && bytes[1] === 216
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!src.startsWith("data:image/") || !signature) failDoc("صور غير مضمنة (PNG/JPEG فقط) لا يمكن حفظها");
  const block = { type: "image" as const, text: "", src, alt: String(node.getAttribute("alt") ?? "").slice(0, 500) };
  if (source?.kind === "rich" && Number.isSafeInteger(source.index)) (block as any).sourceNode = source.index;
  return block;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
