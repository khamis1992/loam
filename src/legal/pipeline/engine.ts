import crypto from "node:crypto";
import type { PipelineStore } from "../db/pipelineStore.js";
import type { LegalPipelineKind, LegalPipelineRun, LegalPipelineStageHandler } from "./types.js";

export class LegalPipeline {
  constructor(private readonly store: PipelineStore, private readonly stages: Record<string, LegalPipelineStageHandler>, private readonly sequence: string[]) {
    if (sequence.length === 0 || sequence.some((stage) => !stages[stage])) throw new Error("invalid legal pipeline stages");
  }

  async start(input: { kind: LegalPipelineKind; matterId: string; state: unknown; corpusSnapshotId: string; model: string; promptVersion: string }): Promise<LegalPipelineRun> {
    const stateJson = JSON.stringify(input.state);
    return this.store.create({
      kind: input.kind, matterId: input.matterId, status: "running", stage: this.sequence[0]!, state: input.state,
      completedStages: [], stageCount: this.sequence.length, inputSha256: crypto.createHash("sha256").update(stateJson, "utf8").digest("hex"),
      corpusSnapshotId: input.corpusSnapshotId, model: input.model, promptVersion: input.promptVersion,
    });
  }

  async advance(id: string, options: { signal?: AbortSignal } = {}): Promise<LegalPipelineRun> {
    const run = this.requireRun(id);
    if (run.status !== "running") return run;
    if (options.signal?.aborted) throw this.save({ ...run, status: "cancelled", error: "cancelled by user" });
    try {
      const result = await this.stages[run.stage]!(run.state, { signal: options.signal });
      if (options.signal?.aborted) throw this.save({ ...run, status: "cancelled", error: "cancelled by user" });
      const completedStages = [...run.completedStages, run.stage];
      if (result.succeeded) {
        return this.save({ ...run, status: "succeeded", completedStages, state: result.state });
      }
      const index = this.sequence.indexOf(run.stage);
      const nextStage = this.sequence[index + 1];
      if (!nextStage) throw new Error(`pipeline ${run.kind} has no terminal stage`);
      return this.save({ ...run, stage: nextStage, completedStages, state: result.state, status: result.waiting ? "waiting" : "running" });
    } catch (error) {
      throw this.save({ ...run, status: options.signal?.aborted ? "cancelled" : "failed", error: options.signal?.aborted ? "cancelled by user" : error instanceof Error ? error.message : String(error) });
    }
  }

  async cancel(id: string): Promise<LegalPipelineRun> {
    const run = this.requireRun(id);
    return run.status === "running" ? this.save({ ...run, status: "cancelled", error: "cancelled by user" }) : run;
  }

  async reactivate(id: string, answer?: unknown): Promise<LegalPipelineRun> {
    const run = this.requireRun(id);
    if (run.status === "failed" || run.status === "cancelled") {
      this.save({ ...run, status: "running", error: undefined });
    } else if (run.status === "waiting") {
      this.save({ ...run, status: "running", state: { ...(typeof run.state === "object" && run.state ? run.state : {}), answer } });
    }
    return this.requireRun(id);
  }

  async resume(id: string, answer?: unknown, options: { signal?: AbortSignal } = {}): Promise<LegalPipelineRun> {
    let current = await this.reactivate(id, answer);
    while (current.status === "running") current = await this.advance(id, options);
    return current;
  }

  private requireRun(id: string): LegalPipelineRun {
    const run = this.store.get(id);
    if (!run) throw new Error(`legal pipeline ${id} not found`);
    return run;
  }

  private save(run: LegalPipelineRun): LegalPipelineRun {
    const next = { ...run, updatedAt: new Date().toISOString() };
    this.store.save(next);
    return next;
  }
}
