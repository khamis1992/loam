import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskPath } from "../server/taskWorkspace.js";

export type StudioArtifact = { title: string; revision: number } & (
  | { kind: "document"; content: { blocks: Array<{ type: "heading" | "paragraph" | "bullet"; text: string; bold?: boolean; italic?: boolean }> } }
  | { kind: "presentation"; content: { slides: Array<{ id: string; title: string; body: string; notes: string; background: string; accent: string }> } }
  | { kind: "spreadsheet"; content: { sheets: Array<{ name: string; cells: string[][] }> } }
);
export class StudioError extends Error { constructor(message: string, public status = 400, public artifact?: StudioArtifact | null) { super(message); } }
const fail = (message: string): never => { throw new StudioError(message); };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Expected an object"); return value as Record<string, unknown>; }
function text(value: unknown, max: number): string { if (typeof value !== "string" || value.length > max) return fail(`Expected text of at most ${max} characters`); return value; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return fail(`Expected at most ${max} items`); return value; }
export function validateStudio(input: unknown): Omit<StudioArtifact, "revision"> {
  const value = object(input), content = object(value.content), title = text(value.title, 300);
  let clean: unknown;
  if (value.kind === "document") {
    clean = { kind: value.kind, title, content: { blocks: array(content.blocks, 2000).map((item) => {
      const block = object(item); if (!["heading", "paragraph", "bullet"].includes(String(block.type))) fail("Invalid block type");
      for (const key of ["bold", "italic"]) if (block[key] !== undefined && typeof block[key] !== "boolean") fail("Invalid text style");
      return { type: block.type, text: text(block.text, 50_000), ...(block.bold !== undefined ? { bold: block.bold } : {}), ...(block.italic !== undefined ? { italic: block.italic } : {}) };
    }) } };
  } else if (value.kind === "presentation") {
    const ids = new Set<string>();
    clean = { kind: value.kind, title, content: { slides: array(content.slides, 200).map((item) => {
      const slide = object(item), id = text(slide.id, 100); if (!id || ids.has(id)) fail("Slide ids must be unique and nonempty"); ids.add(id);
      const color = (v: unknown) => { if (typeof v !== "string" || !/^#[\da-f]{6}$/i.test(v)) return fail("Colors must be six-digit hex values"); return v; };
      return { id, title: text(slide.title, 500), body: text(slide.body, 20_000), notes: text(slide.notes, 20_000), background: color(slide.background), accent: color(slide.accent) };
    }) } };
  } else if (value.kind === "spreadsheet") {
    const names = new Set<string>();
    clean = { kind: value.kind, title, content: { sheets: array(content.sheets, 20).map((item) => {
      const sheet = object(item), name = text(sheet.name, 31); if (!name.trim() || /[\[\]:*?/\\]/.test(name) || names.has(name.toLowerCase())) fail("Sheet names must be unique and valid"); names.add(name.toLowerCase());
      return { name, cells: array(sheet.cells, 2000).map((row) => array(row, 100).map((cell) => text(cell, 10_000))) };
    }) } };
  } else return fail("Invalid studio kind");
  if (Buffer.byteLength(JSON.stringify(clean)) > 2_000_000) fail("Studio content exceeds 2 MB");
  return clean as Omit<StudioArtifact, "revision">;
}
export function readStudio(workspace: string): StudioArtifact | null {
  const file = taskPath(workspace, ".loam/studio.json"); if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 2_001_000) fail("Studio content exceeds 2 MB");
  const value = object(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) fail("Invalid saved revision");
  return { ...validateStudio(value), revision: Number(value.revision) } as StudioArtifact;
}
/** No awaits between compare and atomic rename: concurrent HTTP/tool writes cannot lose edits. */
export function saveStudio(workspace: string, input: unknown, expectedRevision: unknown): StudioArtifact {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) fail("expectedRevision must be a nonnegative integer");
  const clean = validateStudio(input), current = readStudio(workspace);
  if ((current?.revision ?? 0) !== expectedRevision) throw new StudioError("Content changed. Read the latest revision before applying your changes.", 409, current);
  const artifact = { ...clean, revision: Number(expectedRevision) + 1 } as StudioArtifact;
  const file = taskPath(workspace, ".loam/studio.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = taskPath(workspace, `.loam/studio-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(artifact), { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return artifact;
}
export function appendStudio(workspace: string, input: unknown, expectedRevision: unknown): StudioArtifact {
  const value = object(input), current = readStudio(workspace);
  if (!current) return saveStudio(workspace, input, expectedRevision);
  if (current.kind !== value.kind) fail("Cannot append a different studio kind");
  const addition = validateStudio({ ...value, title: value.title ?? current.title }) as StudioArtifact;
  let content: unknown;
  if (current.kind === "document" && addition.kind === "document") content = { blocks: [...current.content.blocks, ...addition.content.blocks] };
  if (current.kind === "presentation" && addition.kind === "presentation") content = { slides: [...current.content.slides, ...addition.content.slides] };
  if (current.kind === "spreadsheet" && addition.kind === "spreadsheet") {
    if (addition.content.sheets.length !== 1 || !current.content.sheets[0]) fail("Append requires one input sheet and an existing first sheet");
    content = { sheets: current.content.sheets.map((sheet, index) => index ? sheet : { ...sheet, cells: [...sheet.cells, ...addition.content.sheets[0]!.cells] }) };
  }
  return saveStudio(workspace, { kind: current.kind, title: current.title, content }, expectedRevision);
}
