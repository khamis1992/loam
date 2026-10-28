import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { LegalPipeline } from "../pipeline/engine.js";
import { analyzeDocuments } from "./documentAnalysis.js";
import type { DocumentAnalysisReport } from "./documentTypes.js";

interface AnalysisState {
  matterId: string;
  report?: DocumentAnalysisReport;
  answer?: { action: "approve" };
}

function withSignal(model: { port: LegalModelPort; config: EgressConfig }, signal?: AbortSignal): { port: LegalModelPort; config: EgressConfig } {
  return { ...model, port: (req) => model.port({ ...req, signal }) };
}

export function createDocumentAnalysisPipeline(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }): LegalPipeline {
  const assertCurrent = (state: AnalysisState) => {
    if (state.report?.corpusSnapshotId !== corpus.snapshot({ persist: false }).id) throw new Error("corpus changed during document analysis; verify again");
  };
  return new LegalPipeline(store.pipeline, {
    intake: async (value) => ({ state: value }),
    evidence: async (value) => ({ state: value }),
    issues: async (value, context) => {
      const state = value as AnalysisState;
      if (!store.getMatter(state.matterId)) throw new Error("matter not found");
      return { state: { ...state, report: await analyzeDocuments(store, corpus, withSignal(model, context?.signal), state.matterId) } };
    },
    research: async (value) => ({ state: value }),
    strategy: async (value) => ({ state: value }),
    draft: async (value) => ({ state: value }),
    adversarial_review: async (value) => ({ state: value }),
    deterministic_verification: async (value) => {
      const state = value as AnalysisState;
      if (!state.report?.summary.trim()) throw new Error("document analysis has no summary");
      assertCurrent(state);
      return { state };
    },
    lawyer_review: async (value) => ({ state: value, waiting: true }),
    export: async (value) => {
      const state = value as AnalysisState;
      if (state.answer?.action !== "approve") throw new Error("final export requires lawyer approval");
      assertCurrent(state);
      return { state, succeeded: true };
    },
  }, ["intake", "evidence", "issues", "research", "strategy", "draft", "adversarial_review", "deterministic_verification", "lawyer_review", "export"]);
}
