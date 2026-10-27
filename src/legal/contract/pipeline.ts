import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { LegalPipeline } from "../pipeline/engine.js";
import { DEFAULT_QATAR_PLAYBOOK, type ContractType } from "./playbook.js";
import { reviewContractDetailed } from "./review.js";
import type { ClientPosition, ContractReviewReport, RiskTolerance } from "./types.js";

interface ContractState {
  matterId: string;
  contractId: string;
  contractType: ContractType;
  clientPosition: ClientPosition;
  riskTolerance: RiskTolerance;
  report?: ContractReviewReport;
  answer?: { action: "approve" };
}

function withSignal(model: { port: LegalModelPort; config: EgressConfig }, signal?: AbortSignal): { port: LegalModelPort; config: EgressConfig } {
  return { ...model, port: (req) => model.port({ ...req, signal }) };
}

export function createContractPipeline(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }): LegalPipeline {
  const assertCurrent = (state: ContractState) => {
    if (state.report?.corpusSnapshotId !== corpus.snapshot({ persist: false }).id) throw new Error("corpus changed during contract review; verify again");
  };
  return new LegalPipeline(store.pipeline, {
    intake: async (value) => ({ state: value }),
    evidence: async (value) => ({ state: value }),
    issues: async (value, context) => {
      const state = value as ContractState;
      const matter = store.getMatter(state.matterId);
      const contract = store.getContract(state.contractId);
      if (!matter || !contract || contract.matterId !== matter.id) throw new Error("contract not found");
      const report = await reviewContractDetailed(store.clauses(contract.id), DEFAULT_QATAR_PLAYBOOK, {
        corpus, asOf: matter.asOf, contractType: state.contractType, fullText: contract.text,
        clientPosition: state.clientPosition, riskTolerance: state.riskTolerance,
      }, withSignal(model, context?.signal));
      return { state: { ...state, report } };
    },
    research: async (value) => ({ state: value }),
    strategy: async (value) => ({ state: value }),
    draft: async (value) => ({ state: value }),
    adversarial_review: async (value) => ({ state: value }),
    deterministic_verification: async (value) => {
      const state = value as ContractState;
      if (!state.report) throw new Error("contract review is missing");
      assertCurrent(state);
      return { state };
    },
    lawyer_review: async (value) => ({ state: value, waiting: true }),
    export: async (value) => {
      const state = value as ContractState;
      if (state.answer?.action !== "approve") throw new Error("final export requires lawyer approval");
      assertCurrent(state);
      return { state, succeeded: true };
    },
  }, ["intake", "evidence", "issues", "research", "strategy", "draft", "adversarial_review", "deterministic_verification", "lawyer_review", "export"]);
}
