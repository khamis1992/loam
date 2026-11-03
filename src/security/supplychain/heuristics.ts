/**
 * Supply-chain heuristics beyond native/pkgintel (guarddog-style ideas, clean-room).
 */
import type { RawFinding } from "../normalize/types.js";

export interface PackageMeta {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  description?: string;
}

const SUSPICIOUS_SCRIPT = /(curl|wget|powershell|Invoke-WebRequest|node\s+-e|eval\()/i;

export function scanPackageScripts(pkg: PackageMeta): RawFinding[] {
  const out: RawFinding[] = [];
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    if (!SUSPICIOUS_SCRIPT.test(script)) continue;
    out.push({
      engine: "supplychain",
      ruleId: "supply.suspicious-script",
      severity: name.startsWith("pre") || name.startsWith("post") ? "high" : "medium",
      target: `${pkg.name}@${pkg.version}:${name}`,
      title: `Suspicious lifecycle script "${name}"`,
      detail: script.slice(0, 200),
      remediation: "Remove network/eval from install scripts or vendor the package after review.",
    });
  }
  return out;
}
