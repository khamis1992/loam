export type MasvsGroup = "STORAGE" | "CRYPTO" | "AUTH" | "NETWORK" | "PLATFORM" | "CODE" | "RESILIENCE" | "PRIVACY";
export type MasvsStatus = "not-tested" | "covered" | "partial" | "not-applicable";

export interface MasvsControl {
  id: string;
  group: MasvsGroup;
  title: string;
  cwe: string[];
}

export interface MasvsCoverage {
  controlId: string;
  status: MasvsStatus;
  applicable: boolean;
  reason: string;
  evidenceIds: string[];
  reviewerId?: string;
  reviewedAt?: string;
}

export const MASVS_CONTROLS: readonly MasvsControl[] = [
  { id: "MASVS-STORAGE-1", group: "STORAGE", title: "Sensitive data is protected in private storage", cwe: ["CWE-312", "CWE-922"] },
  { id: "MASVS-STORAGE-2", group: "STORAGE", title: "Backups and exported files do not expose sensitive data", cwe: ["CWE-312", "CWE-530"] },
  { id: "MASVS-STORAGE-3", group: "STORAGE", title: "Logs, clipboard, cache and screenshots minimize sensitive data", cwe: ["CWE-532", "CWE-359"] },
  { id: "MASVS-CRYPTO-1", group: "CRYPTO", title: "Cryptography follows current standards", cwe: ["CWE-326", "CWE-327"] },
  { id: "MASVS-CRYPTO-2", group: "CRYPTO", title: "Keys are generated, stored and rotated securely", cwe: ["CWE-320", "CWE-798"] },
  { id: "MASVS-AUTH-1", group: "AUTH", title: "Authentication is enforced by the remote endpoint", cwe: ["CWE-287", "CWE-306"] },
  { id: "MASVS-AUTH-2", group: "AUTH", title: "Sessions expire, rotate and revoke securely", cwe: ["CWE-384", "CWE-613"] },
  { id: "MASVS-AUTH-3", group: "AUTH", title: "Authorization is enforced for every user, role and object", cwe: ["CWE-639", "CWE-862"] },
  { id: "MASVS-AUTH-4", group: "AUTH", title: "Recovery and biometric flows cannot bypass remote authentication", cwe: ["CWE-287", "CWE-640"] },
  { id: "MASVS-NETWORK-1", group: "NETWORK", title: "Network traffic is protected by modern TLS", cwe: ["CWE-295", "CWE-319"] },
  { id: "MASVS-NETWORK-2", group: "NETWORK", title: "Endpoint identity and pinning failures are handled securely", cwe: ["CWE-295", "CWE-297"] },
  { id: "MASVS-NETWORK-3", group: "NETWORK", title: "API protocols and alternate channels enforce the same controls", cwe: ["CWE-306", "CWE-319"] },
  { id: "MASVS-PLATFORM-1", group: "PLATFORM", title: "Exported components and IPC enforce permissions", cwe: ["CWE-926", "CWE-927"] },
  { id: "MASVS-PLATFORM-2", group: "PLATFORM", title: "Deep links and app links validate origin and input", cwe: ["CWE-939", "CWE-20"] },
  { id: "MASVS-PLATFORM-3", group: "PLATFORM", title: "WebViews disable unsafe bridges, navigation and content access", cwe: ["CWE-79", "CWE-749"] },
  { id: "MASVS-PLATFORM-4", group: "PLATFORM", title: "Permissions, notifications and shared identities follow least privilege", cwe: ["CWE-250", "CWE-359"] },
  { id: "MASVS-CODE-1", group: "CODE", title: "Code does not expose known exploitable weaknesses", cwe: ["CWE-749", "CWE-94"] },
  { id: "MASVS-CODE-2", group: "CODE", title: "Dependencies and update packages are inventoried and verified", cwe: ["CWE-1104", "CWE-494"] },
  { id: "MASVS-CODE-3", group: "CODE", title: "Debug features, secrets and test backdoors are absent in release", cwe: ["CWE-489", "CWE-798"] },
  { id: "MASVS-RESILIENCE-1", group: "RESILIENCE", title: "Integrity signals are tested without treating them as security boundaries", cwe: ["CWE-693"] },
  { id: "MASVS-RESILIENCE-2", group: "RESILIENCE", title: "Tampering, replay and offline state changes fail safely", cwe: ["CWE-345", "CWE-294"] },
  { id: "MASVS-PRIVACY-1", group: "PRIVACY", title: "Data collection and retention follow minimization", cwe: ["CWE-359"] },
  { id: "MASVS-PRIVACY-2", group: "PRIVACY", title: "Payments, purchases and refunds enforce server-side business rules", cwe: ["CWE-840", "CWE-841"] },
  { id: "MASVS-PRIVACY-3", group: "PRIVACY", title: "Third-party sharing and tracking respect consent and purpose", cwe: ["CWE-359", "CWE-200"] },
] as const;

export function initialMasvsCoverage(): MasvsCoverage[] {
  return MASVS_CONTROLS.map((control) => ({ controlId: control.id, status: "not-tested", applicable: true, reason: "No reviewed evidence", evidenceIds: [] }));
}

export function reviewMasvsControl(input: MasvsCoverage, reviewerId: string): MasvsCoverage {
  if (!reviewerId.trim()) throw new Error("MASVS coverage requires a reviewer");
  if (!input.reason.trim()) throw new Error("MASVS coverage requires a reason");
  if (input.status === "not-applicable") {
    if (input.applicable) throw new Error("not-applicable status conflicts with applicable control");
  } else if (!input.applicable) throw new Error("applicable controls cannot be omitted without a not-applicable review");
  if ((input.status === "covered" || input.status === "partial") && input.evidenceIds.length === 0) throw new Error("covered or partial controls require evidence");
  return { ...input, evidenceIds: [...new Set(input.evidenceIds)], reviewerId, reviewedAt: new Date().toISOString() };
}

export function masvsSummary(entries: MasvsCoverage[]): { applicable: number; covered: number; partial: number; notTested: number; notApplicable: number; coveragePercent: number; complete: boolean } {
  const applicable = entries.filter((entry) => entry.applicable);
  const covered = applicable.filter((entry) => entry.status === "covered").length;
  const partial = applicable.filter((entry) => entry.status === "partial").length;
  const notTested = applicable.filter((entry) => entry.status === "not-tested").length;
  const notApplicable = entries.filter((entry) => !entry.applicable && entry.status === "not-applicable").length;
  return {
    applicable: applicable.length,
    covered,
    partial,
    notTested,
    notApplicable,
    coveragePercent: applicable.length ? Math.round((covered / applicable.length) * 1000) / 10 : 100,
    complete: entries.every((entry) => entry.reviewerId && (entry.applicable ? entry.status === "covered" : entry.status === "not-applicable")),
  };
}
