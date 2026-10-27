import { randomUUID } from "node:crypto";
import { allEntities, getEntity, onDatabaseReset, putEntity, removeEntity } from "../../server/sqliteStore.js";
import { executeOfficeCapability } from "./capabilities.js";
import { readOfficeArtifact } from "./artifactIO.js";
import { OfficeIntelligenceError, type OfficeRun, type StartOfficeRunInput } from "./contracts.js";
import type { OfficeModelGateway } from "./modelGateway.js";
import { legalSourceAnchor, searchLegalSources } from "./legal/sources.js";

const RUN_KIND = "office-intelligence-runs";
const controllers = new Map<string, AbortController>();
onDatabaseReset(() => {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
});

function save(run: OfficeRun): OfficeRun {
  putEntity(RUN_KIND, run);
  return run;
}

function read(id: string): OfficeRun {
  const run = getEntity<OfficeRun>(RUN_KIND, id);
  if (!run) throw new OfficeIntelligenceError("Office intelligence run not found", 404, "run_not_found");
  return run;
}

function prune(): void {
  const runs = allEntities<OfficeRun>(RUN_KIND);
  for (const run of runs.slice(500)) {
    if (!controllers.has(run.id)) removeEntity(RUN_KIND, run.id);
  }
}

export interface OfficeRunExecutionDeps {
  workspace: string;
  model: OfficeModelGateway;
}

export function startOfficeRun(input: StartOfficeRunInput, deps: OfficeRunExecutionDeps): OfficeRun {
  const now = new Date().toISOString();
  const run: OfficeRun = {
    id: `airun_${randomUUID()}`,
    ...input,
    status: "queued",
    model: deps.model.model,
    createdAt: now,
    updatedAt: now,
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  save(run);
  prune();
  const controller = new AbortController();
  controllers.set(run.id, controller);
  void (async () => {
    try {
      save({ ...run, status: "running", updatedAt: new Date().toISOString() });
      const loaded = await readOfficeArtifact(deps.workspace, run.artifact);
      if (controller.signal.aborted) throw new DOMException("run cancelled", "AbortError");
      const additionalSources = run.capability.startsWith("legal-")
        ? searchLegalSources(run.scope, run.instruction, { limit: 8 }).map(legalSourceAnchor)
        : [];
      const result = await executeOfficeCapability({ run, loaded, model: deps.model, additionalSources, signal: controller.signal });
      const current = getEntity<OfficeRun>(RUN_KIND, run.id);
      if (current) save({ ...current, status: "succeeded", result, updatedAt: new Date().toISOString() });
    } catch (error) {
      const current = getEntity<OfficeRun>(RUN_KIND, run.id);
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (current) save({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        ...(cancelled ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }),
        updatedAt: new Date().toISOString(),
      });
    } finally {
      controllers.delete(run.id);
    }
  })();
  return run;
}

export function getOfficeRun(id: string): OfficeRun {
  return read(id);
}

export function listOfficeRuns(options?: { taskId?: string; limit?: number }): OfficeRun[] {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  return allEntities<OfficeRun>(RUN_KIND)
    .filter((run) => !options?.taskId || run.artifact.taskId === options.taskId)
    .slice(0, limit);
}

export function cancelOfficeRun(id: string): OfficeRun {
  const run = read(id);
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return run;
  controllers.get(id)?.abort();
  if (!controllers.has(id)) {
    return save({ ...run, status: "cancelled", updatedAt: new Date().toISOString() });
  }
  return { ...run, status: "cancelled" };
}
