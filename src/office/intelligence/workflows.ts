import { randomUUID } from "node:crypto";
import { addSchedule } from "../../server/db.js";
import { allEntities, getEntity, putEntity, removeEntity } from "../../server/sqliteStore.js";
import { requireTaskWorkspace } from "../../server/taskWorkspace.js";
import { syncConnectorToSheet } from "./connectors.js";
import { applyOfficeLink, listOfficeLinks } from "./links.js";
import { startOfficeRun } from "./service.js";
import type { OfficeModelGateway } from "./modelGateway.js";
import { isRecord, OfficeIntelligenceError, parseArtifactRef, type ArtifactRef, type OfficeRun, type OfficeScope } from "./contracts.js";

const WORKFLOW_KIND = "office-intelligence-workflows";
export type OfficeWorkflowType = "monthly-report" | "meeting-followup" | "link-refresh";

export interface OfficeWorkflow {
  id: string;
  scope: OfficeScope;
  name: string;
  type: OfficeWorkflowType;
  connectorId?: string;
  sourceArtifact?: ArtifactRef;
  targetTaskId?: string;
  outputPath?: string;
  scheduleId?: string;
  createdAt: string;
}

export function registerOfficeWorkflow(input: unknown): OfficeWorkflow {
  if (!isRecord(input) || !isRecord(input.scope)) throw new OfficeIntelligenceError("workflow body and scope are required", 422, "invalid_workflow");
  const type = input.type as OfficeWorkflowType;
  if (!["monthly-report", "meeting-followup", "link-refresh"].includes(type)) throw new OfficeIntelligenceError("workflow type is invalid", 422, "invalid_workflow");
  const id = `wf_${randomUUID()}`;
  const workflow: OfficeWorkflow = {
    id,
    scope: {
      tenantId: String(input.scope.tenantId ?? ""),
      ...(input.scope.projectId ? { projectId: String(input.scope.projectId) } : {}),
      ...(input.scope.matterId ? { matterId: String(input.scope.matterId) } : {}),
    },
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 300) : type,
    type,
    ...(typeof input.connectorId === "string" ? { connectorId: input.connectorId } : {}),
    ...(input.sourceArtifact ? { sourceArtifact: parseArtifactRef(input.sourceArtifact) } : {}),
    ...(typeof input.targetTaskId === "string" ? { targetTaskId: input.targetTaskId } : {}),
    ...(typeof input.outputPath === "string" ? { outputPath: input.outputPath } : {}),
    createdAt: new Date().toISOString(),
  };
  if (!workflow.scope.tenantId) throw new OfficeIntelligenceError("workflow tenant is required", 422, "invalid_workflow");
  if (type === "monthly-report" && (!workflow.connectorId || !workflow.targetTaskId || !workflow.outputPath)) throw new OfficeIntelligenceError("monthly report requires connectorId, targetTaskId and outputPath", 422, "invalid_workflow");
  if (type === "meeting-followup" && !workflow.sourceArtifact) throw new OfficeIntelligenceError("meeting followup requires sourceArtifact", 422, "invalid_workflow");
  if (isRecord(input.schedule) && typeof input.schedule.cron === "string") {
    const timezone = typeof input.schedule.timezone === "string" ? input.schedule.timezone : "Asia/Qatar";
    const schedule = addSchedule(`Use the office_workflow_run tool with id "${id}" exactly once, then report its result and finish. Do not send or publish anything externally.`, 86_400, undefined, undefined, "cron", undefined, true, { cron: input.schedule.cron, timezone });
    workflow.scheduleId = schedule.id;
  }
  putEntity(WORKFLOW_KIND, workflow);
  return workflow;
}

export function getOfficeWorkflow(id: string): OfficeWorkflow {
  const workflow = getEntity<OfficeWorkflow>(WORKFLOW_KIND, id);
  if (!workflow) throw new OfficeIntelligenceError("workflow not found", 404, "workflow_not_found");
  return workflow;
}

export function listOfficeWorkflows(scope: OfficeScope): OfficeWorkflow[] {
  return allEntities<OfficeWorkflow>(WORKFLOW_KIND).filter((workflow) => workflow.scope.tenantId === scope.tenantId && (!scope.projectId || workflow.scope.projectId === scope.projectId) && (!scope.matterId || workflow.scope.matterId === scope.matterId));
}

export function deleteOfficeWorkflow(id: string): void {
  getOfficeWorkflow(id);
  removeEntity(WORKFLOW_KIND, id);
}

export interface OfficeWorkflowRunResult {
  workflowId: string;
  artifact?: ArtifactRef;
  run?: OfficeRun;
  refreshedLinks?: Array<{ id: string; revision: number }>;
}

export async function runOfficeWorkflow(id: string, deps: { baseWorkspace: string; model: OfficeModelGateway }): Promise<OfficeWorkflowRunResult> {
  const workflow = getOfficeWorkflow(id);
  if (workflow.type === "monthly-report") {
    const workspace = requireTaskWorkspace(workflow.targetTaskId!, deps.baseWorkspace);
    const artifact = await syncConnectorToSheet(workflow.connectorId!, { workspace, taskId: workflow.targetTaskId!, path: workflow.outputPath! });
    const run = startOfficeRun({ capability: "sheet-analysis", artifact, scope: workflow.scope, actorId: `workflow:${id}`, instruction: "حلل البيانات المحدثة وقدم مؤشراتها الرئيسية وتحذيرات جودة البيانات." }, { workspace, model: deps.model });
    return { workflowId: id, artifact, run };
  }
  if (workflow.type === "meeting-followup") {
    const artifact = workflow.sourceArtifact!;
    const workspace = requireTaskWorkspace(artifact.taskId, deps.baseWorkspace);
    const run = startOfficeRun({ capability: "doc-actions", artifact, scope: workflow.scope, actorId: `workflow:${id}`, instruction: "استخرج القرارات والمهام والمسؤولين والمواعيد مع مصادرها، ولا تخترع البيانات الناقصة." }, { workspace, model: deps.model });
    return { workflowId: id, artifact, run };
  }
  const refreshedLinks: Array<{ id: string; revision: number }> = [];
  for (const link of listOfficeLinks(workflow.scope)) {
    const result = await applyOfficeLink(link.id, {
      sourceWorkspace: requireTaskWorkspace(link.source.taskId, deps.baseWorkspace),
      targetWorkspace: requireTaskWorkspace(link.target.taskId, deps.baseWorkspace),
    });
    refreshedLinks.push({ id: link.id, revision: result.revision });
  }
  return { workflowId: id, refreshedLinks };
}
