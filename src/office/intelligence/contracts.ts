import type { OfficeEditOp } from "../../tools/officeEditAgent.js";

export const OFFICE_ARTIFACT_KINDS = ["document", "spreadsheet", "presentation"] as const;
export type OfficeArtifactKind = (typeof OFFICE_ARTIFACT_KINDS)[number];

export interface ArtifactRef {
  taskId: string;
  path: string;
  kind: OfficeArtifactKind;
  revision: number;
  contentHash: string;
  tenantId: string;
}

export type SourceAnchorKind = "block" | "region" | "cell" | "range" | "slide" | "shape" | "chart" | "file";

export interface SourceAnchor {
  id: string;
  artifact: ArtifactRef;
  kind: SourceAnchorKind;
  anchor: string;
  excerpt: string;
  contentHash: string;
}

export interface OfficeScope {
  tenantId: string;
  projectId?: string;
  matterId?: string;
}

export const OFFICE_CAPABILITIES = [
  "doc-summary",
  "doc-grounded-draft",
  "doc-actions",
  "doc-compare",
  "sheet-formula",
  "sheet-analysis",
  "sheet-cleaning",
  "sheet-anomalies",
  "sheet-forecast",
  "slides-storyboard",
  "slides-deck",
  "legal-research",
  "legal-matter-timeline",
  "legal-evidence-matrix",
  "legal-partner-review",
  "legal-contract-review",
  "legal-client-brief",
] as const;
export type OfficeCapability = (typeof OFFICE_CAPABILITIES)[number];

export interface OfficeChangeSet {
  id: string;
  artifact: ArtifactRef;
  expectedRevision: number;
  ops: OfficeEditOp[];
  preview: string[];
  destructive: boolean;
  createdAt: string;
}

export interface OfficeRunResult {
  summary: string;
  content?: string;
  citations: SourceAnchor[];
  warnings: string[];
  data?: unknown;
  changeSet?: OfficeChangeSet;
}

export type OfficeRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OfficeRun {
  id: string;
  capability: OfficeCapability;
  artifact: ArtifactRef;
  scope: OfficeScope;
  actorId: string;
  instruction: string;
  status: OfficeRunStatus;
  model: string;
  createdAt: string;
  updatedAt: string;
  result?: OfficeRunResult;
  error?: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface StartOfficeRunInput {
  capability: OfficeCapability;
  artifact: ArtifactRef;
  scope: OfficeScope;
  actorId: string;
  instruction: string;
}

export class OfficeIntelligenceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "office_intelligence_error") {
    super(message);
    this.name = "OfficeIntelligenceError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new OfficeIntelligenceError(`${name} must be a ${allowEmpty ? "valid" : "non-empty"} string of at most ${max} characters`, 422, "invalid_contract");
  }
  return value;
}

export function parseArtifactRef(value: unknown): ArtifactRef {
  if (!isRecord(value)) throw new OfficeIntelligenceError("artifact is required", 422, "invalid_contract");
  const kind = boundedString(value.kind, "artifact.kind", 30) as OfficeArtifactKind;
  if (!OFFICE_ARTIFACT_KINDS.includes(kind)) throw new OfficeIntelligenceError("artifact.kind is unsupported", 422, "invalid_contract");
  const revision = Number(value.revision);
  const contentHash = boundedString(value.contentHash, "artifact.contentHash", 64);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new OfficeIntelligenceError("artifact.revision is invalid", 422, "invalid_contract");
  if (!/^[a-f0-9]{64}$/i.test(contentHash)) throw new OfficeIntelligenceError("artifact.contentHash is invalid", 422, "invalid_contract");
  return {
    taskId: boundedString(value.taskId, "artifact.taskId", 200),
    path: boundedString(value.path, "artifact.path", 500),
    kind,
    revision,
    contentHash: contentHash.toLowerCase(),
    tenantId: boundedString(value.tenantId, "artifact.tenantId", 200),
  };
}

export function parseStartOfficeRunInput(value: unknown, actorId: string): StartOfficeRunInput {
  if (!isRecord(value)) throw new OfficeIntelligenceError("request body is required", 422, "invalid_contract");
  const capability = boundedString(value.capability, "capability", 80) as OfficeCapability;
  if (!OFFICE_CAPABILITIES.includes(capability)) throw new OfficeIntelligenceError("capability is unsupported", 422, "invalid_contract");
  if (!isRecord(value.scope)) throw new OfficeIntelligenceError("scope is required", 422, "invalid_contract");
  const scope: OfficeScope = {
    tenantId: boundedString(value.scope.tenantId, "scope.tenantId", 200),
    ...(value.scope.projectId ? { projectId: boundedString(value.scope.projectId, "scope.projectId", 200) } : {}),
    ...(value.scope.matterId ? { matterId: boundedString(value.scope.matterId, "scope.matterId", 200) } : {}),
  };
  return {
    capability,
    artifact: parseArtifactRef(value.artifact),
    scope,
    actorId: boundedString(actorId, "actorId", 200),
    instruction: boundedString(value.instruction, "instruction", 20_000, true),
  };
}

export function assertCapabilityMatchesArtifact(capability: OfficeCapability, kind: OfficeArtifactKind): void {
  const group = capability.startsWith("legal-") ? null : capability.split("-")[0];
  const expected = group === "doc" ? "document" : group === "sheet" ? "spreadsheet" : group === "slides" ? "presentation" : null;
  if (expected && expected !== kind) throw new OfficeIntelligenceError(`${capability} cannot run on ${kind}`, 422, "capability_artifact_mismatch");
}
