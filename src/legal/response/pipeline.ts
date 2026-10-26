import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { qualityGate } from "../analysis/claimSupport.js";
import { adversarialReview } from "../analysis/adversarial.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { LegalPipeline } from "../pipeline/engine.js";
import { buildAllegationMatrix } from "./allegations.js";
import { draftLegalResponse } from "./draft.js";
import { researchResponse } from "./responseStrategy.js";
import type { AllegationResponseMatrix } from "./types.js";

interface ResponseState {
  matterId: string;
  sourceText: string;
  matrix?: AllegationResponseMatrix;
  research?: Awaited<ReturnType<typeof researchResponse>>;
  draft?: string;
  verification?: Awaited<ReturnType<typeof draftLegalResponse>>["verification"];
  adversarial?: Awaited<ReturnType<typeof adversarialReview>>;
  answer?: { action: "approve" | "revise"; matrix?: AllegationResponseMatrix };
}

export function createResponsePipeline(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }): LegalPipeline {
  const matter = (state: ResponseState) => {
    const value = store.getMatter(state.matterId);
    if (!value) throw new Error(`matter ${state.matterId} not found`);
    return value;
  };
  return new LegalPipeline(store.pipeline, {
    intake: async (value) => ({ state: value }),
    evidence: async (value) => ({ state: value }),
    issues: async (value) => {
      const state = value as ResponseState;
      const matrix = await buildAllegationMatrix(model, {
        matter: matter(state), sourceText: state.sourceText, documents: store.evidence.listDocuments(state.matterId),
        facts: store.evidence.listFacts(state.matterId), timeline: store.evidence.listTimeline(state.matterId),
      });
      return { state: { ...state, matrix } };
    },
    research: async (value) => {
      const state = value as ResponseState;
      return { state: { ...state, research: await researchResponse(corpus, model, state.matrix!, matter(state).asOf) } };
    },
    strategy: async (value) => ({ state: value, waiting: true }),
    draft: async (value) => {
      const state = value as ResponseState;
      if (state.answer?.action === "revise" && state.answer.matrix) state.matrix = state.answer.matrix;
      if (state.answer?.action !== "approve" && state.answer?.action !== "revise") throw new Error("response strategy requires approval or revision");
      return { state: { ...state, ...(await draftLegalResponse(corpus, model, { matter: matter(state), matrix: state.matrix!, research: state.research! })) } };
    },
    adversarial_review: async (value) => {
      const state = value as ResponseState;
      return { state: { ...state, adversarial: await adversarialReview(model, { draft: state.draft!, facts: state.matrix, authorities: state.research, coverage: state.verification!.coverage }) } };
    },
    deterministic_verification: async (value) => {
      const state = value as ResponseState;
      const quality = qualityGate({ claims: state.research!.flatMap((record) => record.claims), findings: state.adversarial, coverage: state.verification!.coverage });
      if (!quality.ok) throw new Error(`response quality gate failed: ${quality.issues.map((issue) => issue.code).join(",")}`);
      return { state: { ...state, quality } };
    },
    lawyer_review: async (value) => ({ state: value, waiting: true }),
    export: async (value) => {
      const state = value as ResponseState;
      if (state.answer?.action !== "approve") throw new Error("final export requires lawyer approval");
      return { state, succeeded: true };
    },
  }, ["intake", "evidence", "issues", "research", "strategy", "draft", "adversarial_review", "deterministic_verification", "lawyer_review", "export"]);
}
