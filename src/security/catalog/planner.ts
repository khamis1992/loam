import { authorizationActive, targetInScope, type AuthorizationRecord } from "../red/gate.js";
import type { CatalogPlatform, CatalogStage, VulnerabilityRecord } from "./types.js";

export interface CatalogPlanItem {
  vulnerabilityId: string;
  stage: CatalogStage;
  status: "planned" | "blocked" | "unavailable";
  reason: string;
  validationKey: string;
}

export interface CatalogPlanOptions {
  platform: CatalogPlatform;
  technologies: string[];
  target: string;
  authorization: AuthorizationRecord | null;
  approvalGranted?: boolean;
}

const dynamicKeys = new Set(["http.injection", "http.xss", "http.csrf", "http.cors", "http.ssrf", "http.xxe", "http.deserialization", "http.upload", "http.traversal", "http.redirect", "http.template", "http.command", "http.auth", "http.business", "http.race", "http.websocket", "http.graphql", "mobile.authorization", "mobile.instrumentation"]);
const unsupported = new Set(["disabled"]);
const registeredKeys = new Set([...dynamicKeys, "static.review", "manual.review", "mobile.storage", "mobile.network", "mobile.platform", "mobile.crypto", "mobile.privacy"]);

export function buildCatalogPlan(records: VulnerabilityRecord[], options: CatalogPlanOptions): CatalogPlanItem[] {
  const technologies = new Set(options.technologies.map((item) => item.toLowerCase()));
  const active = options.authorization && authorizationActive(options.authorization) && targetInScope(options.authorization.scope, options.target);
  const applicable = records.filter((record) => record.platforms.includes(options.platform) || record.platforms.includes("shared"));
  const items: CatalogPlanItem[] = [];
  for (const record of applicable) {
    const techMatch = record.techHints.length === 0 || record.techHints.some((hint) => technologies.has(hint.toLowerCase()) || [...technologies].some((technology) => technology.includes(hint.toLowerCase())));
    if (!techMatch) continue;
    const dynamic = dynamicKeys.has(record.validationKey);
    let status: CatalogPlanItem["status"] = "planned";
    let reason = dynamic ? "registered dynamic validation" : "registered static/manual review";
    if (unsupported.has(record.validationKey) || record.action === "disabled") {
      status = "blocked";
      reason = "action disabled by safety policy";
    } else if (!registeredKeys.has(record.validationKey)) {
      status = "unavailable";
      reason = "no registered validator for this vulnerability class";
    } else if (dynamic && !active) {
      status = "blocked";
      reason = "active signed authorization and target scope required";
    } else if (record.action === "approval-required" && !options.approvalGranted) {
      status = "blocked";
      reason = "independent approval required";
    }
    const stage: CatalogStage = record.reverseEngineering ? "reverse-engineering" : dynamic ? "dynamic" : record.validationKey === "static.review" ? "static" : "source";
    items.push({ vulnerabilityId: record.id, stage, status, reason, validationKey: record.validationKey });
    items.push({ vulnerabilityId: record.id, stage: "retest", status: status === "planned" ? "planned" : status, reason: status === "planned" ? "retest after remediation is mandatory" : reason, validationKey: "retest" });
  }
  return items;
}

export function catalogCoverage(items: CatalogPlanItem[]): { planned: number; blocked: number; unavailable: number; clean: boolean } {
  const planned = items.filter((item) => item.status === "planned").length;
  const blocked = items.filter((item) => item.status === "blocked").length;
  const unavailable = items.filter((item) => item.status === "unavailable").length;
  return { planned, blocked, unavailable, clean: items.length > 0 && blocked === 0 && unavailable === 0 };
}
