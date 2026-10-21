/** Presentation workspace IO: read, edit and write back .pptx task files.
 * Reuses the studio PPTX import/export path (zip + OOXML editing) so every
 * save produces a native PowerPoint file that keeps its original parts.
 * Each edited file keeps its own hidden edit base under .loam/slides/<hash>/. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { taskPath } from "../taskWorkspace.js";
import { importStudio } from "../../studio/import.js";
import { exportStudio } from "../../studio/export.js";
import { StudioError, readStudio, saveStudio, type StudioArtifact } from "../../studio/store.js";
import { safeZip, part, all, first, attr, serialize, xml, P, R } from "../../studio/ooxml.js";

const EDIT_PREFIX = ".loam/slides";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const PKG_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

type EditMeta = { path: string; size: number; mtime: number };

function editDir(root: string, rel: string): string {
  const hash = createHash("sha1").update(rel).digest("hex").slice(0, 16);
  return taskPath(root, path.posix.join(EDIT_PREFIX, hash));
}

function assertPptx(rel: string): void {
  if (!rel || !rel.toLowerCase().endsWith(".pptx")) throw new StudioError("Workspace slides editing supports .pptx files only");
}

function targetFile(root: string, rel: string): string {
  const target = taskPath(root, rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new StudioError("Presentation file not found in the task workspace", 404);
  return target;
}

function readMeta(dir: string): EditMeta | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as EditMeta; } catch { return null; }
}

function writeMeta(dir: string, target: string, rel: string): void {
  const stat = fs.statSync(target);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ path: rel, size: stat.size, mtime: stat.mtimeMs } satisfies EditMeta));
}

/** Write a pptx buffer to the task file atomically. */
function writeTaskFile(root: string, rel: string, dir: string, buffer: Buffer): void {
  const target = targetFile(root, rel);
  const temporary = taskPath(root, path.posix.join(EDIT_PREFIX, path.basename(dir), `write-${randomUUID()}.tmp`));
  try { fs.writeFileSync(temporary, buffer, { flag: "wx" }); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  writeMeta(dir, target, rel);
}

/** Import the task file into the edit base when the file changed on disk. */
async function ensureImported(root: string, rel: string): Promise<{ dir: string; artifact: StudioArtifact }> {
  assertPptx(rel);
  const target = targetFile(root, rel);
  const dir = editDir(root, rel);
  const stat = fs.statSync(target);
  const meta = readMeta(dir);
  const stale = !meta || meta.path !== rel || meta.size !== stat.size || Math.abs(meta.mtime - stat.mtimeMs) > 2;
  let artifact: StudioArtifact | null = null;
  if (!stale) {
    try { artifact = readStudio(dir); } catch { artifact = null; }
  }
  if (!artifact) await reimportBase(root, dir, rel, fs.readFileSync(target));
  artifact = readStudio(dir) as StudioArtifact;
  if (artifact.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
  return { dir, artifact };
}

async function reimportBase(root: string, dir: string, rel: string, buffer: Buffer): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await importStudio(dir, buffer, path.basename(rel), 0);
  writeMeta(dir, targetFile(root, rel), rel);
}

/** Structured slides JSON for one task workspace file. */
export async function readWorkspaceSlides(root: string, rel: string): Promise<{ artifact: StudioArtifact; warnings: string[] }> {
  const { artifact } = await ensureImported(root, rel);
  return { artifact, warnings: artifact.warnings ?? [] };
}

/** Raw bytes of the task file, suitable for downloads and onSave blobs. */
export function readWorkspaceSlidesRaw(root: string, rel: string): Buffer {
  assertPptx(rel);
  return fs.readFileSync(targetFile(root, rel));
}

/** Save edited slides: store the artifact in the edit base, re-export the pptx
 * through the studio round-trip and atomically write it back to the task file. */
export async function saveWorkspaceSlides(root: string, rel: string, input: unknown, expectedRevision: unknown): Promise<{ artifact: StudioArtifact; bytes: number }> {
  const { dir } = await ensureImported(root, rel);
  const saved = saveStudio(dir, input, expectedRevision);
  if (saved.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
  const output = await exportStudio(saved, dir);
  writeTaskFile(root, rel, dir, output.buffer);
  return { artifact: saved, bytes: output.buffer.length };
}

/** Duplicate one slide of the saved task file by cloning its slide part in the
 * pptx zip, then re-importing so every slide keeps a unique source anchor.
 * When save inputs are provided they are applied first, so the duplicate is
 * created from the client's current state. */
export async function duplicateWorkspaceSlide(
  root: string,
  rel: string,
  index: unknown,
  save?: { artifact: unknown; expectedRevision: unknown },
): Promise<{ artifact: StudioArtifact }> {
  const { dir, artifact } = await ensureImported(root, rel);
  if (artifact.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
  if (save) await saveWorkspaceSlides(root, rel, save.artifact, save.expectedRevision);
  const current = readStudio(dir) as StudioArtifact;
  if (current.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
  const position = Number(index);
  if (!Number.isSafeInteger(position) || position < 0 || position >= current.content.slides.length) {
    throw new StudioError("Invalid slide index");
  }
  const buffer = await duplicateSlideInPptx(fs.readFileSync(targetFile(root, rel)), position);
  // Write the duplicated pptx back, then re-anchor the edit base from it.
  writeTaskFile(root, rel, dir, buffer);
  await reimportBase(root, dir, rel, buffer);
  const result = readStudio(dir) as StudioArtifact;
  if (result.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
  return { artifact: result };
}

/** Zip surgery: copy the slide part, its rels (minus the shared notes link) and
 * register the new part in presentation.xml and [Content_Types].xml. */
async function duplicateSlideInPptx(buffer: Buffer, index: number): Promise<Buffer> {
  const zip = await safeZip(buffer);
  const presentation = await part(zip, "ppt/presentation.xml");
  const list = first(presentation, P, "sldIdLst");
  const ids = all(presentation, P, "sldId");
  if (!list || ids.length === 0) throw new StudioError("Presentation has no slides");
  const sourceId = ids[index]!;
  const rels = await part(zip, "ppt/_rels/presentation.xml.rels");
  const sourceRel = all(rels, "*", "Relationship").find((n: any) => attr(n, "Id") === attr(sourceId, "r:id"));
  if (!sourceRel || attr(sourceRel, "TargetMode") === "External") throw new StudioError("Invalid slide relationship");
  const sourceTarget = attr(sourceRel, "Target");
  if (sourceTarget.startsWith("/") || sourceTarget.includes("..")) throw new StudioError("Invalid slide part");
  const sourcePart = path.posix.normalize(path.posix.join("ppt", sourceTarget));

  let maxPart = 0;
  for (const name of Object.keys(zip.files)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (match) maxPart = Math.max(maxPart, Number(match[1]));
  }
  const newPart = `ppt/slides/slide${maxPart + 1}.xml`;
  const newRelsPart = `ppt/slides/_rels/slide${maxPart + 1}.xml.rels`;

  const usedRelIds = new Set(all(rels, "*", "Relationship").map((n: any) => attr(n, "Id")));
  const usedSldIds = new Set(ids.map((n: any) => attr(n, "id")));
  let relNumber = 1;
  while (usedRelIds.has(`rId${relNumber}`)) relNumber++;
  let sldNumber = 256;
  while (usedSldIds.has(String(sldNumber))) sldNumber++;

  const sourceRelsFile = `ppt/slides/_rels/${path.posix.basename(sourcePart)}.rels`;
  zip.file(newPart, await zip.file(sourcePart)!.async("string"));

  // Slide rels clone: keep layout and media links, drop the shared notes link.
  if (zip.file(sourceRelsFile)) {
    const sourceRels = await part(zip, sourceRelsFile);
    for (const rel of all(sourceRels, "*", "Relationship")) {
      if (attr(rel, "Type").endsWith("/notesSlide")) rel.parentNode?.removeChild(rel);
    }
    zip.file(newRelsPart, serialize(sourceRels));
  }

  // Register the new slide part in the package content types.
  const contentTypes = await part(zip, "[Content_Types].xml");
  const override = xml(`<Override xmlns="${PKG_CT_NS}" PartName="/${newPart}" ContentType="${SLIDE_CT}"/>`).documentElement;
  contentTypes.documentElement.appendChild(contentTypes.importNode(override, true));
  zip.file("[Content_Types].xml", serialize(contentTypes));

  // Register the new slide relationship, then list it right after its source.
  const relationship = xml(`<Relationship xmlns="${PKG_REL_NS}" Id="rId${relNumber}" Type="${SLIDE_REL_TYPE}" Target="slides/${path.posix.basename(newPart)}"/>`).documentElement;
  rels.documentElement.appendChild(rels.importNode(relationship, true));
  zip.file("ppt/_rels/presentation.xml.rels", serialize(rels));

  const sldId = xml(`<p:sldId xmlns:p="${P}" xmlns:r="${R}" id="${sldNumber}" r:id="rId${relNumber}"/>`).documentElement;
  list.insertBefore(presentation.ownerDocument.importNode(sldId, true), sourceId.nextSibling);
  zip.file("ppt/presentation.xml", serialize(presentation));

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
