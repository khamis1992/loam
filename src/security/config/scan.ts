import type { RawFinding } from "../normalize/types.js";
import type { SecurityFinding } from "../findings.js";
import { toSecurityFindings } from "../normalize/funnel.js";
import { scanDockerfile } from "./dockerfile.js";

export interface ConfigScanOptions { dockerfiles?: Array<{ path: string; text: string }> }

export function configScan(opt: ConfigScanOptions): { findings: SecurityFinding[]; dropped: number } {
  const raw: RawFinding[] = [];
  for (const d of opt.dockerfiles ?? []) raw.push(...scanDockerfile(d.text, d.path));
  const findings = toSecurityFindings(raw);
  return { findings, dropped: 0 };
}
