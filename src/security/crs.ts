import { validateWithControls, type ControlObservation } from "./validators.js";

export interface CrsClaim {
  id: string;
  specialist: string;
  claim: string;
  sensitivity: number;
}

export interface CrsRepair {
  findingId: string;
  summary: string;
  buildPassed: boolean;
  testsPassed: boolean;
  retestPassed: boolean;
  evidenceIds: string[];
}

export interface CrsResult {
  findings: Array<CrsClaim & { status: string; reason: string; evidenceIds: string[] }>;
  gaps: string[];
  repairs: Array<CrsRepair & { status: "verified" | "unverified" }>;
  clean: boolean;
}

export async function runCrs(
  claims: CrsClaim[],
  deps: {
    validate: (claim: CrsClaim) => Promise<{ positive: ControlObservation; negative: ControlObservation }>;
    criticize: (claims: CrsClaim[]) => Promise<string[]>;
    repairs?: CrsRepair[];
  },
): Promise<CrsResult> {
  const findings: CrsResult["findings"] = [];
  for (const claim of claims) {
    const controls = await deps.validate(claim);
    const result = validateWithControls(controls.positive, controls.negative);
    findings.push({ ...claim, status: result.status, reason: result.reason, evidenceIds: result.evidenceIds });
  }
  const gaps = await deps.criticize(claims);
  const repairs = (deps.repairs ?? []).map((repair) => ({
    ...repair,
    status: repair.buildPassed && repair.testsPassed && repair.retestPassed && repair.evidenceIds.length > 0 ? "verified" as const : "unverified" as const,
  }));
  const clean = findings.every((finding) => finding.status === "refuted") && gaps.length === 0 && repairs.every((repair) => repair.status === "verified");
  return { findings, gaps, repairs, clean };
}
