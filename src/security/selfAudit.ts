/**
 * Loam self-audit (Cap A, MISSING §4 A-DD2). PC file `selfharden.ts` currently
 * holds skill distillation (OBSERVED) — it stays untouched; self-audit lives here.
 * Deterministic checks only; no model calls, no filesystem access.
 */
export type SelfAuditSeverity = "info" | "warn" | "fail";

export interface SelfAuditCheck {
  id: string;
  title: string;
  severity: SelfAuditSeverity;
  ok: boolean;
  detail: string;
}

export interface SelfAuditReport {
  checks: SelfAuditCheck[];
  ok: boolean;
  failed: string[];
  warned: string[];
}

export interface SelfAuditInput {
  packageJson?: { engines?: { node?: string }; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  protectedPathsRegistered?: string[];
  untrustedToolNames?: string[];
  asarAuditMode?: "warn" | "fail" | "off";
  hasMastraDep?: boolean;
  sparklesInUi?: boolean;
}

const REQUIRED_PROTECTED = ["integration-grants"];

export function runSelfAudit(input: SelfAuditInput): SelfAuditReport {
  const checks: SelfAuditCheck[] = [];

  const nodeEng = input.packageJson?.engines?.node ?? "";
  checks.push({
    id: "self.node-engine",
    title: "Node engine floor >=22.13",
    severity: "fail",
    ok: />=?\s*22\.(1[3-9]|[2-9]\d)/.test(nodeEng) || nodeEng.includes("22.13"),
    detail: `engines.node=${nodeEng || "(missing)"}`,
  });

  const deps = { ...input.packageJson?.dependencies, ...input.packageJson?.optionalDependencies };
  const hasMastra = input.hasMastraDep ?? Object.keys(deps).some((k) => k === "@mastra" || k.startsWith("@mastra/"));
  checks.push({
    id: "self.no-mastra",
    title: "No @mastra dependency",
    severity: "fail",
    ok: !hasMastra,
    detail: hasMastra ? "forbidden @mastra found" : "clean",
  });

  const prot = new Set(input.protectedPathsRegistered ?? []);
  const missingProt = REQUIRED_PROTECTED.filter((p) => ![...prot].some((x) => x.includes(p)));
  checks.push({
    id: "self.protected-paths",
    title: "Critical protected paths registered",
    severity: "warn",
    ok: missingProt.length === 0,
    detail: missingProt.length ? `missing: ${missingProt.join(",")}` : "ok",
  });

  const untrusted = input.untrustedToolNames ?? [];
  checks.push({
    id: "self.untrusted-names",
    title: "Untrusted tool name list non-empty",
    severity: "warn",
    ok: untrusted.length > 0,
    detail: `count=${untrusted.length}`,
  });

  const asar = input.asarAuditMode ?? "warn";
  checks.push({
    id: "self.asar-mode",
    title: "ASAR audit mode warn|fail",
    severity: "info",
    ok: asar === "warn" || asar === "fail",
    detail: `mode=${asar}`,
  });

  checks.push({
    id: "self.no-sparkles",
    title: "No Sparkles icon in UI tree",
    severity: "fail",
    ok: !(input.sparklesInUi ?? false),
    detail: input.sparklesInUi ? "Sparkles detected" : "clean",
  });

  const failed = checks.filter((c) => c.severity === "fail" && !c.ok).map((c) => c.id);
  const warned = checks.filter((c) => c.severity === "warn" && !c.ok).map((c) => c.id);
  return { checks, ok: failed.length === 0, failed, warned };
}
