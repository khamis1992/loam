import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { qualityGate } from "../analysis/claimSupport.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { LegalPipeline } from "../pipeline/engine.js";
import { buildCaseTheory } from "./caseTheory.js";
import { draftDefenseMemo } from "./draft.js";
import { opposeDefense } from "./opponent.js";
import { researchDefense } from "./strategy.js";
import type { CaseTheory } from "./types.js";

interface DefenseState {
  matterId: string;
  theory?: CaseTheory;
  research?: Awaited<ReturnType<typeof researchDefense>>;
  draft?: string;
  verification?: Awaited<ReturnType<typeof draftDefenseMemo>>["verification"];
  adversarial?: Awaited<ReturnType<typeof opposeDefense>>;
  answer?: { action: "approve" | "revise"; theory?: CaseTheory };
}

function withSignal(model: { port: LegalModelPort; config: EgressConfig }, signal?: AbortSignal): { port: LegalModelPort; config: EgressConfig } {
  return { ...model, port: (req) => model.port({ ...req, signal }) };
}

export function createDefensePipeline(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }): LegalPipeline {
  const matter = (state: DefenseState) => {
    const value = store.getMatter(state.matterId);
    if (!value) throw new Error(`matter ${state.matterId} not found`);
    return value;
  };
  return new LegalPipeline(store.pipeline, {
    intake: async (value) => ({ state: value }),
    evidence: async (value) => {
      const state = value as DefenseState;
      matter(state);
      return { state: { ...state, evidence: store.evidence.listDocuments(state.matterId) } };
    },
    issues: async (value, context) => {
      const state = value as DefenseState;
      const theory = await buildCaseTheory(withSignal(model, context?.signal), {
        matter: matter(state), documents: store.evidence.listDocuments(state.matterId), facts: store.evidence.listFacts(state.matterId),
        timeline: store.evidence.listTimeline(state.matterId), contradictions: store.evidence.listContradictions(state.matterId),
      });
      return { state: { ...state, theory } };
    },
    research: async (value, context) => {
      const state = value as DefenseState;
      const research = await researchDefense(corpus, withSignal(model, context?.signal), state.theory!, matter(state).asOf, [matter(state).title], store.evidence.listFacts(state.matterId), state.research ?? []);
      return { state: { ...state, research } };
    },
    strategy: async (value) => ({ state: value, waiting: true }),
    draft: async (value, context) => {
      const state = value as DefenseState;
      if (state.answer?.action === "revise" && state.answer.theory) {
        state.theory = state.answer.theory;
        state.research = await researchDefense(corpus, withSignal(model, context?.signal), state.theory, matter(state).asOf, [matter(state).title], store.evidence.listFacts(state.matterId), state.research ?? []);
      }
      if (state.answer?.action !== "approve" && state.answer?.action !== "revise") throw new Error("defense strategy requires approval or revision");
      const drafted = await draftDefenseMemo(corpus, withSignal(model, context?.signal), { matter: matter(state), theory: state.theory!, research: state.research!, facts: store.evidence.listFacts(state.matterId) });
      return { state: { ...state, ...drafted } };
    },
    adversarial_review: async (value, context) => {
      let state = value as DefenseState;
      let adversarial = await opposeDefense(withSignal(model, context?.signal), { draft: state.draft!, theory: state.theory!, research: state.research!, coverage: state.verification!.coverage });
      if (adversarial.some((finding) => finding.severity === "critical")) {
        const revision = await draftDefenseMemo(corpus, withSignal(model, context?.signal), { matter: matter(state), theory: state.theory!, research: state.research!, facts: store.evidence.listFacts(state.matterId), revision: { draft: state.draft!, findings: adversarial } });
        state = { ...state, ...revision };
        adversarial = await opposeDefense(withSignal(model, context?.signal), { draft: state.draft!, theory: state.theory!, research: state.research!, coverage: state.verification!.coverage });
      }
      return { state: { ...state, adversarial } };
    },
    deterministic_verification: async (value) => {
      const state = value as DefenseState;
      const quality = qualityGate({ claims: state.research!.flatMap((record) => record.claims), findings: state.adversarial, coverage: state.verification!.coverage });
      if (!quality.ok) throw new Error(`defense quality gate failed: ${quality.issues.map((issue) => issue.code).join(",")}`);
      if (state.verification!.corpusSnapshotId !== corpus.snapshot({ persist: false }).id) throw new Error("corpus changed during defense; verify again");
      return { state: { ...state, quality } };
    },
    lawyer_review: async (value) => ({ state: value, waiting: true }),
    export: async (value) => {
      const state = value as DefenseState;
      if (state.answer?.action !== "approve") throw new Error("final export requires lawyer approval");
      if (state.verification!.corpusSnapshotId !== corpus.snapshot({ persist: false }).id) throw new Error("corpus changed during lawyer review; verify again");
      return { state, succeeded: true };
    },
  }, ["intake", "evidence", "issues", "research", "strategy", "draft", "adversarial_review", "deterministic_verification", "lawyer_review", "export"]);
}
