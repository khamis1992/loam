import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { taskPath } from "../../server/taskWorkspace.js";
import { loadWorkspaceDoc, saveWorkspaceDoc, parseMarker, markerLine, blocksToHtml } from "../../server/workspace/docIO.js";
import { readSheetDoc, writeSheetDoc, type SheetDoc, type EditorSheet } from "../../server/workspace/sheetIO.js";
import { readWorkspaceSlides, saveWorkspaceSlides } from "../../server/workspace/slidesIO.js";
import { loadImport } from "../../studio/import.js";
import type { StudioArtifact, DocumentBlock } from "../../studio/store.js";
import { columnLetters } from "../../tools/officeEditAgent.js";
import { applyOfficeChangeSet } from "./changesets.js";
import { createSourceAnchor } from "./citations.js";
import { OfficeIntelligenceError, type ArtifactRef, type OfficeArtifactKind, type OfficeChangeSet, type SourceAnchor } from "./contracts.js";

export interface LoadedOfficeArtifact {
  ref: ArtifactRef;
  artifact: StudioArtifact;
  docSession?: string;
  docMtimeMs?: number;
  sheetDoc?: SheetDoc;
}

function extensionFor(kind: OfficeArtifactKind): string {
  return kind === "document" ? ".docx" : kind === "spreadsheet" ? ".xlsx" : ".pptx";
}

export async function loadOfficeArtifact(
  workspace: string,
  identity: { taskId: string; path: string; kind: OfficeArtifactKind; tenantId: string },
): Promise<LoadedOfficeArtifact> {
  const abs = taskPath(workspace, identity.path);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new OfficeIntelligenceError("Office artifact not found", 404, "artifact_not_found");
  if (path.extname(identity.path).toLowerCase() !== extensionFor(identity.kind)) {
    throw new OfficeIntelligenceError(`expected a ${extensionFor(identity.kind)} artifact`, 422, "artifact_kind_mismatch");
  }
  const contentHash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  let artifact: StudioArtifact;
  const loaded: LoadedOfficeArtifact = {
    ref: { ...identity, revision: 0, contentHash },
    artifact: undefined as unknown as StudioArtifact,
  };
  if (identity.kind === "document") {
    const doc = await loadWorkspaceDoc(workspace, identity.path);
    const marker = parseMarker(doc.html);
    if (!marker) throw new OfficeIntelligenceError("document edit session could not be created", 409, "import_failed");
    const baseline = loadImport(workspace, marker.session).manifest.artifact;
    if (baseline.kind !== "document") throw new OfficeIntelligenceError("document import kind mismatch", 409, "import_failed");
    artifact = baseline;
    loaded.docSession = marker.session;
    loaded.docMtimeMs = marker.mtimeMs;
  } else if (identity.kind === "spreadsheet") {
    const doc = await readSheetDoc(abs, { taskId: identity.taskId, path: identity.path, name: path.basename(identity.path) });
    artifact = {
      kind: "spreadsheet",
      title: doc.name,
      revision: 0,
      content: {
        sheets: doc.sheets.map((sheet, sourceIndex) => ({ ...sheet, sourceIndex })),
      },
    };
    loaded.sheetDoc = doc;
  } else {
    const result = await readWorkspaceSlides(workspace, identity.path);
    if (result.artifact.kind !== "presentation") throw new OfficeIntelligenceError("presentation import kind mismatch", 409, "import_failed");
    artifact = result.artifact;
  }
  loaded.artifact = artifact;
  loaded.ref.revision = artifact.revision;
  return loaded;
}

export async function readOfficeArtifact(workspace: string, ref: ArtifactRef): Promise<LoadedOfficeArtifact> {
  const loaded = await loadOfficeArtifact(workspace, ref);
  if (loaded.ref.contentHash !== ref.contentHash || loaded.artifact.revision !== ref.revision) {
    throw new OfficeIntelligenceError("the artifact changed; describe it again before continuing", 409, "revision_conflict");
  }
  return loaded;
}

function blockText(block: DocumentBlock): string {
  if (block.type === "table") return [block.columns, ...block.rows].map((row) => row.join(" | ")).join("\n");
  if (block.type === "stats") return block.items.map((item) => `${item.label}: ${item.value}`).join("\n");
  if (block.type === "image") return block.alt;
  return block.text;
}

export function officeSourceAnchors(loaded: LoadedOfficeArtifact): SourceAnchor[] {
  const { artifact, ref } = loaded;
  const anchors: SourceAnchor[] = [];
  const add = (kind: SourceAnchor["kind"], anchor: string, text: string) => {
    if (text.trim() && anchors.length < 10_000) anchors.push(createSourceAnchor({ artifact: ref, kind, anchor, text }));
  };
  if (artifact.kind === "document") {
    artifact.content.blocks.forEach((block, index) => add("block", String(index + 1), blockText(block)));
    for (const region of artifact.content.regions ?? []) add("region", region.label, region.text);
  } else if (artifact.kind === "spreadsheet") {
    for (const sheet of artifact.content.sheets) {
      sheet.cells.forEach((row, r) => row.forEach((value, c) => add("cell", `${sheet.name}!${columnLetters(c + 1)}${r + 1}`, value)));
    }
  } else {
    for (const slide of artifact.content.slides) add("slide", slide.id, [slide.title, slide.body, slide.notes].filter(Boolean).join("\n"));
  }
  return anchors;
}

export function officeArtifactText(loaded: LoadedOfficeArtifact): string {
  return officeSourceAnchors(loaded).map((anchor) => `[${anchor.id}] ${anchor.kind}:${anchor.anchor}\n${anchor.excerpt}`).join("\n\n").slice(0, 120_000);
}

export async function resolveOfficeSourceAsync(workspace: string, anchor: SourceAnchor): Promise<{ artifact: ArtifactRef; text: string } | undefined> {
  try {
    const loaded = await loadOfficeArtifact(workspace, anchor.artifact);
    const match = officeSourceAnchors(loaded).find((candidate) => candidate.kind === anchor.kind && candidate.anchor === anchor.anchor);
    if (!match) return undefined;
    return { artifact: loaded.ref, text: match.excerpt };
  } catch {
    return undefined;
  }
}

export async function saveOfficeChangeSet(workspace: string, changeSet: OfficeChangeSet): Promise<{ revision: number; contentHash: string }> {
  const loaded = await readOfficeArtifact(workspace, changeSet.artifact);
  const result = applyOfficeChangeSet(loaded.artifact, changeSet);
  if (loaded.ref.kind === "document") {
    if (result.artifact.kind !== "document" || !loaded.docSession || loaded.docMtimeMs === undefined) throw new OfficeIntelligenceError("document save session is unavailable", 409, "save_failed");
    const html = `${markerLine(loaded.docSession, loaded.docMtimeMs)}\n${blocksToHtml(result.artifact.content.blocks, result.artifact.content.regions ?? [])}`;
    await saveWorkspaceDoc(workspace, loaded.ref.path, html);
  } else if (loaded.ref.kind === "spreadsheet") {
    if (result.artifact.kind !== "spreadsheet" || !loaded.sheetDoc) throw new OfficeIntelligenceError("spreadsheet save session is unavailable", 409, "save_failed");
    const sheets: EditorSheet[] = result.artifact.content.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.cells,
      styles: sheet.styles ?? {},
      columnWidths: sheet.columnWidths ?? [],
      rowHeights: sheet.rowHeights ?? [],
      merges: sheet.merges ?? [],
      hiddenRows: sheet.hiddenRows ?? [],
      hiddenColumns: sheet.hiddenColumns ?? [],
    }));
    await writeSheetDoc(taskPath(workspace, loaded.ref.path), { ...loaded.sheetDoc, sheets });
  } else {
    if (result.artifact.kind !== "presentation") throw new OfficeIntelligenceError("presentation save session is unavailable", 409, "save_failed");
    await saveWorkspaceSlides(workspace, loaded.ref.path, result.artifact, changeSet.expectedRevision);
  }
  const abs = taskPath(workspace, loaded.ref.path);
  const contentHash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  return { revision: changeSet.expectedRevision + 1, contentHash };
}
