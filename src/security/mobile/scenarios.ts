import { MASVS_CONTROLS } from "./masvs.js";

export type ScenarioMethod = "automated" | "manual";
export type ScenarioOutcome = "not-run" | "pass" | "finding" | "inconclusive" | "unavailable";

export interface MobileScenario {
  id: string;
  controlId: string;
  title: string;
  method: ScenarioMethod;
  requiredEvidence: "request" | "screen" | "code" | "log" | "device" | "manual";
}

export interface ScenarioResult {
  scenarioId: string;
  outcome: Exclude<ScenarioOutcome, "not-run">;
  observation: string;
  evidenceIds: string[];
}

const definitions: Array<Omit<MobileScenario, "method"> & { method?: ScenarioMethod }> = [
  { id: "storage-private-files", controlId: "MASVS-STORAGE-1", title: "Private files and databases do not expose secrets", requiredEvidence: "device" },
  { id: "storage-backup-extraction", controlId: "MASVS-STORAGE-2", title: "Backup extraction respects release policy", requiredEvidence: "device" },
  { id: "storage-sensitive-logs", controlId: "MASVS-STORAGE-3", title: "Logs exclude sessions and personal data", requiredEvidence: "log" },
  { id: "privacy-clipboard-screenshots", controlId: "MASVS-STORAGE-3", title: "Clipboard and screenshots protect sensitive screens", requiredEvidence: "screen" },
  { id: "crypto-algorithm-review", controlId: "MASVS-CRYPTO-1", title: "No weak algorithms or deterministic encryption", requiredEvidence: "code" },
  { id: "crypto-key-storage", controlId: "MASVS-CRYPTO-2", title: "Keys use platform protected storage", requiredEvidence: "device" },
  { id: "auth-remote-enforcement", controlId: "MASVS-AUTH-1", title: "Remote endpoints reject unauthenticated access", requiredEvidence: "request" },
  { id: "auth-session-revocation", controlId: "MASVS-AUTH-2", title: "Logout and revocation invalidate old sessions", requiredEvidence: "request" },
  { id: "auth-bola-object", controlId: "MASVS-AUTH-3", title: "Another user cannot read or change a protected object", requiredEvidence: "request" },
  { id: "auth-cross-tenant", controlId: "MASVS-AUTH-3", title: "Tenant boundaries hold for every object", requiredEvidence: "request" },
  { id: "auth-account-recovery", controlId: "MASVS-AUTH-4", title: "Recovery cannot bypass identity verification", requiredEvidence: "manual" },
  { id: "network-tls-validation", controlId: "MASVS-NETWORK-1", title: "Invalid TLS identities are rejected", requiredEvidence: "request" },
  { id: "network-cleartext", controlId: "MASVS-NETWORK-1", title: "Sensitive traffic cannot use cleartext", requiredEvidence: "request" },
  { id: "network-alternate-channels", controlId: "MASVS-NETWORK-3", title: "GraphQL, WebSocket and gRPC enforce equivalent authorization", requiredEvidence: "request" },
  { id: "platform-exported-components", controlId: "MASVS-PLATFORM-1", title: "Exported components reject unauthorized callers", requiredEvidence: "device" },
  { id: "platform-deep-links", controlId: "MASVS-PLATFORM-2", title: "Deep links validate source, action and object", requiredEvidence: "device" },
  { id: "platform-webview-bridges", controlId: "MASVS-PLATFORM-3", title: "WebViews restrict bridges and unsafe navigation", requiredEvidence: "screen" },
  { id: "code-release-backdoors", controlId: "MASVS-CODE-3", title: "Release builds exclude debug backdoors and secrets", requiredEvidence: "code" },
  { id: "business-payment-refund", controlId: "MASVS-PRIVACY-2", title: "Payments and refunds enforce server-side rules", requiredEvidence: "manual" },
  { id: "business-offline-replay", controlId: "MASVS-RESILIENCE-2", title: "Offline state and replay cannot bypass server rules", requiredEvidence: "manual" },
];

export const MOBILE_SCENARIOS: readonly MobileScenario[] = definitions.map((scenario) => ({ ...scenario, method: scenario.method ?? "automated" } as MobileScenario));

export function completeScenario(result: ScenarioResult): ScenarioResult {
  const scenario = MOBILE_SCENARIOS.find((item) => item.id === result.scenarioId);
  if (!scenario) throw new Error("unknown mobile scenario");
  if (!result.observation.trim()) throw new Error("scenario observation is required");
  if ((result.outcome === "pass" || result.outcome === "finding") && result.evidenceIds.length === 0) throw new Error("conclusive scenarios require evidence");
  return { ...result, evidenceIds: [...new Set(result.evidenceIds)] };
}

export function validateScenarioCatalog(): void {
  const ids = new Set<string>();
  const controls = new Set(MASVS_CONTROLS.map((control) => control.id));
  for (const scenario of MOBILE_SCENARIOS) {
    if (ids.has(scenario.id) || !controls.has(scenario.controlId)) throw new Error(`invalid scenario catalog entry ${scenario.id}`);
    ids.add(scenario.id);
  }
  if (ids.size < 20) throw new Error("at least 20 mobile scenarios are required");
}
