import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { adversarialReview } from "./adversarial.js";
import { qualityGate } from "./claimSupport.js";
import { analyzeDocuments } from "./documentAnalysis.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { LegalPipeline } from "../pipeline/engine.js";

interface DocumentState {
  matterId: string;
  report?: Awaited<ReturnType<typeof analyzeDocuments>>;
  adversarial?: Awaited<ReturnType<typeof adversarialReview>>;
  answer?: { action: "approve" | "revise" };
}

export function createDocumentPipeline(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }): LegalPipeline {
  return new LegalPipeline(store.pipeline, {
    intake: async (value) => ({ state: value }),
    evidence: async (value) => ({ state: value }),
    issues: async (value) => {
      const state = value as DocumentState;
      return { state: { ...state, report: await analyzeDocuments(store, corpus, model, state.matterId) } };
    },
    research: async (value) => ({ state: value }),
    strategy: async (value) => ({ state: value, waiting: true }),
    draft: async (value) => ({ state: value }),
    adversarial_review: async (value) => {
      const state = value as DocumentState;
      return { state: { ...state, adversarial: await adversarialReview(model, { draft: state.report!.summary, facts: state.report!.obligations, authorities: state.report!.risks, coverage: state.report!.coverage }) } };
    },
    deterministic_verification: async (value) => {
      const state = value as DocumentState;
      const quality = qualityGate({ claims: [], findings: state.adversarial, coverage: state.report!.coverage });
      if (!quality.ok) throw new Error(`document quality gate failed: ${quality.issues.map((issue) => issue.code).join(",")}`);
      return { state: { ...state, quality } };
    },
    lawyer_review: async (value) => ({ state: value, waiting: true }),
    export: async (value) => {
      const state = value as DocumentState;
      if (state.answer?.action !== "approve") throw new Error("final export requires lawyer approval");
      return { state, succeeded: true };
    },
  }, ["intake", "evidence", "issues", "research", "strategy", "draft", "adversarial_review", "deterministic_verification", "lawyer_review", "export"]);
}
