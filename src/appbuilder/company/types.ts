import type { AppScenario, TemplateFeatureId } from "../types.js";

export type CompanyStage = "awaiting_approval" | "design" | "build" | "verify" | "repair" | "version" | "done" | "failed" | "cancelled";

export interface ProductBrief {
  idea: string;
  scenario: AppScenario;
  features: TemplateFeatureId[];
  users: string[];
  requirements: string[];
  constraints: string[];
  userStories: string[];
  acceptance: string[];
  questions: string[];
}

export interface CompanyRun {
  id: string;
  projectId: string;
  idea: string;
  stage: CompanyStage;
  brief: ProductBrief;
  verifyReportId: string | null;
  versionNumber: number | null;
  previewUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
