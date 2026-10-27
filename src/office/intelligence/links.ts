import { randomUUID } from "node:crypto";
import { allEntities, getEntity, putEntity, removeEntity } from "../../server/sqliteStore.js";
import type { OfficeEditOp } from "../../tools/officeEditAgent.js";
import { loadOfficeArtifact, officeSourceAnchors, readOfficeArtifact, saveOfficeChangeSet } from "./artifactIO.js";
import { createOfficeChangeSet } from "./changesets.js";
import { isRecord, OfficeIntelligenceError, parseArtifactRef, type ArtifactRef, type OfficeChangeSet, type OfficeScope, type SourceAnchorKind } from "./contracts.js";

const LINK_KIND = "office-intelligence-links";
export type OfficeLinkTargetField = "cell" | "block" | "slide-title" | "slide-body" | "slide-notes";

export interface OfficeLink {
  id: string;
  scope: OfficeScope;
  source: ArtifactRef;
  sourceKind: SourceAnchorKind;
  sourceAnchor: string;
  target: ArtifactRef;
  targetField: OfficeLinkTargetField;
  targetAnchor: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeLinkPreview {
  link: OfficeLink;
  sourceValue: string;
  changeSet: OfficeChangeSet;
}

function anchor(value: unknown, name: string): { kind: SourceAnchorKind; anchor: string } {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.anchor !== "string" || !value.anchor || value.anchor.length > 300) {
    throw new OfficeIntelligenceError(`${name} is invalid`, 422, "invalid_link");
  }
  return { kind: value.kind as SourceAnchorKind, anchor: value.anchor };
}

function targetOp(link: OfficeLink, value: string): OfficeEditOp {
  if (link.targetField === "cell" && link.target.kind === "spreadsheet") {
    const [sheet, address] = link.targetAnchor.includes("!") ? link.targetAnchor.split("!", 2) : [undefined, link.targetAnchor];
    if (!address) throw new OfficeIntelligenceError("target cell is invalid", 422, "invalid_link");
    return { op: "set-cell", address, value, ...(sheet ? { sheet } : {}) };
  }
  if (link.targetField === "block" && link.target.kind === "document") {
    const block = Number(link.targetAnchor);
    if (!Number.isSafeInteger(block) || block < 1) throw new OfficeIntelligenceError("target block is invalid", 422, "invalid_link");
    return { op: "set-block-text", block, value };
  }
  const slide = Number(link.targetAnchor);
  if (!Number.isSafeInteger(slide) || slide < 1 || link.target.kind !== "presentation") throw new OfficeIntelligenceError("target slide is invalid", 422, "invalid_link");
  if (link.targetField === "slide-title") return { op: "set-slide-title", slide, value };
  if (link.targetField === "slide-body") return { op: "set-slide-body", slide, value };
  if (link.targetField === "slide-notes") return { op: "set-slide-notes", slide, value };
  throw new OfficeIntelligenceError("target and link type do not match", 422, "invalid_link");
}

export function createOfficeLink(input: unknown): OfficeLink {
  if (!isRecord(input) || !isRecord(input.scope) || !isRecord(input.source) || !isRecord(input.target)) throw new OfficeIntelligenceError("link body and scope are required", 422, "invalid_link");
  const sourceAnchor = anchor(input.source, "source");
  const targetAnchor = anchor(input.target, "target");
  const targetField = input.targetField as OfficeLinkTargetField;
  if (!["cell", "block", "slide-title", "slide-body", "slide-notes"].includes(targetField)) throw new OfficeIntelligenceError("targetField is invalid", 422, "invalid_link");
  const now = new Date().toISOString();
  const link: OfficeLink = {
    id: `link_${randomUUID()}`,
    scope: {
      tenantId: String(input.scope.tenantId ?? ""),
      ...(input.scope.projectId ? { projectId: String(input.scope.projectId) } : {}),
      ...(input.scope.matterId ? { matterId: String(input.scope.matterId) } : {}),
    },
    source: parseArtifactRef(input.source.artifact),
    sourceKind: sourceAnchor.kind,
    sourceAnchor: sourceAnchor.anchor,
    target: parseArtifactRef(input.target.artifact),
    targetField,
    targetAnchor: targetAnchor.anchor,
    createdAt: now,
    updatedAt: now,
  };
  if (!link.scope.tenantId || link.source.tenantId !== link.scope.tenantId || link.target.tenantId !== link.scope.tenantId) throw new OfficeIntelligenceError("link tenants must match", 403, "scope_denied");
  targetOp(link, "validation");
  return link;
}

export function registerOfficeLink(input: unknown): OfficeLink {
  const link = createOfficeLink(input);
  putEntity(LINK_KIND, link);
  return link;
}

export function getOfficeLink(id: string): OfficeLink {
  const link = getEntity<OfficeLink>(LINK_KIND, id);
  if (!link) throw new OfficeIntelligenceError("Office link not found", 404, "link_not_found");
  return link;
}

export function listOfficeLinks(scope: OfficeScope): OfficeLink[] {
  return allEntities<OfficeLink>(LINK_KIND).filter((link) => link.scope.tenantId === scope.tenantId && (!scope.projectId || link.scope.projectId === scope.projectId) && (!scope.matterId || link.scope.matterId === scope.matterId));
}

export function deleteOfficeLink(id: string): void {
  getOfficeLink(id);
  removeEntity(LINK_KIND, id);
}

export interface OfficeLinkWorkspaces {
  sourceWorkspace: string;
  targetWorkspace: string;
}

export async function previewOfficeLink(id: string, workspaces: OfficeLinkWorkspaces): Promise<OfficeLinkPreview> {
  const link = getOfficeLink(id);
  const source = await loadOfficeArtifact(workspaces.sourceWorkspace, link.source);
  const sourceAnchor = officeSourceAnchors(source).find((item) => item.kind === link.sourceKind && item.anchor === link.sourceAnchor);
  if (!sourceAnchor) throw new OfficeIntelligenceError("source anchor no longer exists", 409, "source_changed");
  const target = await readOfficeArtifact(workspaces.targetWorkspace, link.target);
  const current: OfficeLink = { ...link, source: source.ref, updatedAt: new Date().toISOString() };
  putEntity(LINK_KIND, current);
  return { link: current, sourceValue: sourceAnchor.excerpt, changeSet: createOfficeChangeSet(target.ref, [targetOp(current, sourceAnchor.excerpt)]) };
}

export async function applyOfficeLink(id: string, workspaces: OfficeLinkWorkspaces): Promise<{ link: OfficeLink; revision: number }> {
  const preview = await previewOfficeLink(id, workspaces);
  const saved = await saveOfficeChangeSet(workspaces.targetWorkspace, preview.changeSet);
  const link: OfficeLink = {
    ...preview.link,
    target: { ...preview.link.target, revision: saved.revision, contentHash: saved.contentHash },
    updatedAt: new Date().toISOString(),
  };
  putEntity(LINK_KIND, link);
  return { link, revision: saved.revision };
}
