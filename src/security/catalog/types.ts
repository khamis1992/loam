export type CatalogPlatform = "web" | "android" | "ios" | "shared";
export type CatalogAction = "read-only" | "approval-required" | "disabled";
export type CatalogStage = "recon" | "source" | "static" | "dynamic" | "reverse-engineering" | "retest";

export interface VulnerabilityRecord {
  id: string;
  kind: "class" | "cve";
  title: string;
  description: string;
  platforms: CatalogPlatform[];
  categories: string[];
  cwe: string[];
  capec: string[];
  owasp: string[];
  severity: "info" | "low" | "medium" | "high" | "critical";
  prerequisites: string[];
  detectionMethods: string[];
  validationKey: string;
  evidenceRequired: string[];
  techHints: string[];
  reverseEngineering: boolean;
  action: CatalogAction;
  impact: string;
  remediation: string;
}

export interface CatalogFilter {
  platform?: CatalogPlatform;
  category?: string;
  cwe?: string;
  validationKey?: string;
  query?: string;
  limit?: number;
}
