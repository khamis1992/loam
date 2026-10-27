import { createHash, randomUUID } from "node:crypto";
import { applyOfficeEdits, type AppliedOp, type OfficeEditOp } from "../../tools/officeEditAgent.js";
import type { StudioArtifact } from "../../studio/store.js";
import { OfficeIntelligenceError, type ArtifactRef, type OfficeChangeSet } from "./contracts.js";

const STUDIO_KIND = { document: "document", spreadsheet: "spreadsheet", presentation: "presentation" } as const;

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

export function officeChangeSetDigest(changeSet: OfficeChangeSet): string {
  return createHash("sha256").update(canonical(changeSet)).digest("hex");
}

function previewOp(op: OfficeEditOp): string {
  switch (op.op) {
    case "set-title": return `تحديث العنوان إلى «${op.value}»`;
    case "set-cell": return `تحديث الخلية ${op.address}${op.sheet ? ` في ${op.sheet}` : ""}`;
    case "replace-text": return `استبدال «${op.find}»${op.slide !== undefined ? ` في الشريحة ${op.slide}` : ""}`;
    case "set-slide-title": return `تحديث عنوان الشريحة ${op.slide}`;
    case "set-slide-body": return `تحديث محتوى الشريحة ${op.slide}`;
    case "set-slide-notes": return `تحديث ملاحظات الشريحة ${op.slide}`;
    case "set-block-text": return `تحديث الفقرة ${op.block}`;
    case "set-region-text": return `تحديث المنطقة ${op.label}`;
  }
}

export function createOfficeChangeSet(artifact: ArtifactRef, ops: OfficeEditOp[]): OfficeChangeSet {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100) {
    throw new OfficeIntelligenceError("a change set must contain between 1 and 100 operations", 422, "invalid_changeset");
  }
  return {
    id: `chg_${randomUUID()}`,
    artifact,
    expectedRevision: artifact.revision,
    ops: structuredClone(ops),
    preview: ops.map(previewOp),
    destructive: ops.some((op) => op.op === "replace-text"),
    createdAt: new Date().toISOString(),
  };
}

export function assertExpectedRevision(artifact: StudioArtifact, ref: ArtifactRef, expectedRevision: number): void {
  if (artifact.kind !== STUDIO_KIND[ref.kind]) throw new OfficeIntelligenceError("artifact kind changed", 409, "artifact_changed");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new OfficeIntelligenceError("expectedRevision is invalid", 422, "invalid_revision");
  }
  if (artifact.revision !== expectedRevision || ref.revision !== expectedRevision) {
    throw new OfficeIntelligenceError("the artifact changed since the preview was created", 409, "revision_conflict");
  }
}

export function applyOfficeChangeSet(
  artifact: StudioArtifact,
  changeSet: OfficeChangeSet,
): { artifact: StudioArtifact; applied: AppliedOp[] } {
  assertExpectedRevision(artifact, changeSet.artifact, changeSet.expectedRevision);
  const result = applyOfficeEdits(artifact, changeSet.ops);
  if (result.skipped.length > 0) {
    const reason = result.skipped.map((item) => item.reason).join("; ");
    throw new OfficeIntelligenceError(`change set was not applied: ${reason}`, 422, "changeset_rejected");
  }
  if (result.applied.length !== changeSet.ops.length) {
    throw new OfficeIntelligenceError("change set was not applied completely", 422, "changeset_incomplete");
  }
  return { artifact: result.artifact, applied: result.applied };
}
