/** Native secrets scanner entry: findings -> SARIF and ReconHit. Raw secret values never leave the engine. */
import { SecretScanner } from "./engine.js";
import type { SecretFinding } from "./engine.js";
import { loadIgnoreFile, scanDirectory } from "./sources.js";
import { DEFAULT_RULES } from "./rules.js";
import { rulesWithGitleaks } from "./gitleaks.js";
import path from "node:path";
import type { ReconHit } from "../../audit/types.js";

export { SecretScanner, redact, shannonEntropy } from "./engine.js";
export type { SecretFinding } from "./engine.js";
export { scanDirectory, scanGitHistory, parseGitLog, loadIgnoreFile } from "./sources.js";
export { DEFAULT_RULES } from "./rules.js";
export { loadGitleaksRules, rulesWithGitleaks } from "./gitleaks.js";

const LEVEL = { critical: "error", high: "error", medium: "warning" } as const;

export function toSarif(findings: SecretFinding[]): Record<string, unknown> {
  const rules = [...new Map(findings.map((f) => [f.ruleId, f.description])).entries()]
    .map(([id, d]) => ({ id, shortDescription: { text: d } }));
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "loam-secrets", rules } },
      results: findings.map((f) => ({
        ruleId: f.ruleId, level: LEVEL[f.severity], message: { text: `${f.description} (${f.secret})` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: Math.max(1, f.line) } } }],
        partialFingerprints: { "loam/v1": f.fingerprint },
      })),
    }],
  };
}

export function toHits(findings: SecretFinding[]): ReconHit[] {
  return findings.map((f) => ({
    tool: "loam-secrets", ruleId: f.ruleId, message: `${f.description} (${f.secret})`, file: f.file, line: Math.max(1, f.line),
    cls: "secret", severity: f.severity === "medium" ? "medium" : "high", deterministic: true, raw: { fingerprint: f.fingerprint },
  }));
}

export function runSecretsScan(root: string, opts: { rulesDir?: string } = {}): { hits: ReconHit[]; sarif: Record<string, unknown> } {
  const rulesDir = opts.rulesDir ?? path.resolve(process.cwd(), "rules");
  const merged = rulesWithGitleaks(rulesDir, DEFAULT_RULES);
  const scanner = new SecretScanner({
    ignore: loadIgnoreFile(root),
    redactPercent: 100,
    ...(merged ? { rules: merged.rules, globalAllow: merged.globalAllow } : {}),
  });
  const findings = scanDirectory(root, scanner);
  return { hits: toHits(findings), sarif: toSarif(findings) };
}
