export type LegalPipelineKind = "contract_review" | "defense_memo" | "legal_response" | "document_analysis";
export type LegalPipelineStatus = "running" | "waiting" | "failed" | "cancelled" | "succeeded";

export interface LegalPipelineRun {
  id: string;
  kind: LegalPipelineKind;
  matterId: string;
  status: LegalPipelineStatus;
  stage: string;
  state: unknown;
  completedStages: string[];
  stageCount?: number;
  inputSha256: string;
  corpusSnapshotId: string;
  model: string;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface LegalPipelineStageResult {
  state: unknown;
  waiting?: boolean;
  succeeded?: boolean;
}

export type LegalPipelineStageHandler = (state: unknown, context?: { signal?: AbortSignal }) => Promise<LegalPipelineStageResult>;
