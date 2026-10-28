import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import type { MattersStore } from "../mattersStore.js";
import type { LegalModelPort } from "../model/types.js";
import { createDefensePipeline } from "../defense/pipeline.js";
import { createResponsePipeline } from "../response/pipeline.js";
import { createDocumentAnalysisPipeline } from "../analysis/pipeline.js";
import { createContractPipeline } from "../contract/pipeline.js";
import type { ClientPosition, RiskTolerance } from "../contract/types.js";
import type { ContractType } from "../contract/playbook.js";
import type { LegalPipeline } from "./engine.js";
import type { LegalPipelineKind, LegalPipelineRun } from "./types.js";

export type ManagedPipelineKind = LegalPipelineKind;

export class LegalRunManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly drives = new Map<string, Promise<void>>();

  constructor(private readonly store: MattersStore, private readonly corpus: LegalCorpus, private readonly model: { port: LegalModelPort; config: EgressConfig }) {}

  async start(kind: ManagedPipelineKind, matterId: string, state: { matterId: string; sourceText?: string; contractId?: string; contractType?: ContractType; clientPosition?: ClientPosition; riskTolerance?: RiskTolerance }): Promise<LegalPipelineRun> {
    const matter = this.store.getMatter(matterId);
    if (!matter) throw new Error(`matter ${matterId} not found`);
    const pipeline = this.createPipeline(kind);
    const run = await pipeline.start({ kind, matterId, state, corpusSnapshotId: this.corpus.snapshot({ persist: true }).id, model: this.model.config.localModel, promptVersion: "1" });
    this.store.audit.append("user", "run.start", matterId, run.id, { kind });
    this.drive(run.id);
    return run;
  }

  get(id: string): LegalPipelineRun | undefined { return this.store.pipeline.get(id); }
  list(matterId: string): LegalPipelineRun[] { return this.store.pipeline.list(matterId); }

  async cancel(id: string): Promise<LegalPipelineRun> {
    const run = this.store.pipeline.get(id);
    if (!run) throw new Error(`legal pipeline ${id} not found`);
    this.controllers.get(id)?.abort();
    const cancelled = await this.createPipeline(run.kind as ManagedPipelineKind).cancel(id);
    this.store.audit.append("user", "run.cancel", run.matterId, id, { stage: run.stage });
    return cancelled;
  }

  async resume(id: string, answer?: unknown): Promise<LegalPipelineRun> {
    await this.drives.get(id)?.catch(() => undefined);
    const current = this.store.pipeline.get(id);
    if (!current) throw new Error(`legal pipeline ${id} not found`);
    const pipeline = this.createPipeline(current.kind as ManagedPipelineKind);
    const run = await pipeline.reactivate(id, answer);
    this.store.audit.append("user", "run.resume", run.matterId, id, { stage: run.stage });
    this.drive(id);
    return run;
  }

  async idle(id: string): Promise<LegalPipelineRun | undefined> {
    await this.drives.get(id)?.catch(() => undefined);
    return this.get(id);
  }

  private drive(id: string): void {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const promise = (async () => {
      let run = this.store.pipeline.get(id);
      while (run?.status === "running") run = await this.createPipeline(run.kind as ManagedPipelineKind).advance(id, { signal: controller.signal });
    })().catch(() => undefined).finally(() => {
      this.drives.delete(id);
      this.controllers.delete(id);
    });
    this.drives.set(id, promise);
  }

  private createPipeline(kind: ManagedPipelineKind): LegalPipeline {
    if (kind === "defense_memo") return createDefensePipeline(this.store, this.corpus, this.model);
    if (kind === "legal_response") return createResponsePipeline(this.store, this.corpus, this.model);
    if (kind === "document_analysis") return createDocumentAnalysisPipeline(this.store, this.corpus, this.model);
    return createContractPipeline(this.store, this.corpus, this.model);
  }
}
