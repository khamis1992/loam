/**
 * Binary analysis capability (Supremacy M8): static reverse-engineering pass on
 * any binary file — PE/ELF/Mach-O/APK/JAR — reusing the first-party `src/re`
 * engine. The subject is NEVER executed; findings carry sha256 evidence.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { PentestFinding } from "../../tools/pentest.js";
import type { Evidence } from "../orchestrator.js";
import { nextEvidenceId } from "../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "./orchestrator/redOrchestrator.js";
import { analyzeBinary, identify, printableStrings, type BinaryIdentity } from "../../re/binary.js";
import type { ReFinding } from "../../re/types.js";

export interface BinaryAnalysisSummary {
  file: string;
  identity: BinaryIdentity;
  sha256: string;
  entropy: number;
  stringCount: number;
  suspiciousStrings: string[];
  packed: boolean;
}

export function analyzeBinaryFile(filePath: string): BinaryAnalysisSummary {
  const buf = fs.readFileSync(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const { identity, findings } = analyzeBinary(filePath, buf);
  const strings = printableStrings(buf);
  const packedFinding = findings.find((f) => f.ruleId === "re-packed");
  const stringsFinding = findings.find((f) => f.ruleId === "re-suspicious-strings");
  return {
    file: filePath,
    identity,
    sha256,
    entropy: Number(/entropy=([\d.]+)/.exec(findings[0]?.detail ?? "")?.[1] ?? 0),
    stringCount: strings.length,
    suspiciousStrings: stringsFinding?.detail.split(", ").map((s) => s.replace(/^"|"$/g, "")).slice(0, 10) ?? [],
    packed: !!packedFinding,
  };
}

export function binaryCapability(opts: { filePath?: string } = {}): RedCapability {
  return {
    id: "red.binary.analysis",
    applicable: (target) => /\.(exe|dll|so|dylib|bin|apk|jar|dex|sys)$/i.test(target) || opts.filePath !== undefined,
    hunt: async (target): Promise<RedHypothesis[]> => [
      {
        id: `HYP-BIN-${target.length}`,
        capability: "red.binary.analysis",
        target,
        claim: "Binary security findings from static analysis",
        rationale: "First-party reverse-engineering engine (src/re/binary.ts)",
      },
    ],
    validate: async (hyp: RedHypothesis, _ctx: RedCapabilityContext): Promise<RedValidation> => {
      const filePath = opts.filePath ?? hyp.target;
      let summary: BinaryAnalysisSummary;
      try {
        summary = analyzeBinaryFile(filePath);
      } catch (err) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `binary read failed: ${(err as Error).message}`, evidence: [] };
      }
      const evidence: Evidence[] = [
        {
          id: nextEvidenceId(),
          kind: "poc",
          at: new Date().toISOString(),
          poc: `analyzeBinary(${filePath})`,
          observed: `format=${summary.identity.format} arch=${summary.identity.arch ?? "?"} entropy=${summary.entropy.toFixed(2)} sha256=${summary.sha256.slice(0, 16)}… strings=${summary.stringCount}${summary.packed ? " PACKED" : ""}`,
        },
      ];
      const findings: Omit<PentestFinding, "id">[] = [];
      if (summary.packed) {
        findings.push({
          check: "red_binary_packed",
          verdict: "finding",
          severity: "medium",
          title: "High entropy suggests packing/encryption",
          target: filePath,
          detail: `Entropy ${summary.entropy.toFixed(2)} (>7.2). The binary may be packed or encrypted.`,
          remediation: "Unpack before deeper static analysis.",
        });
      }
      if (summary.suspiciousStrings.length > 0) {
        findings.push({
          check: "red_binary_suspicious_strings",
          verdict: "finding",
          severity: "low",
          title: `${summary.suspiciousStrings.length} notable string(s) in binary`,
          target: filePath,
          detail: summary.suspiciousStrings.map((s) => s.slice(0, 100)).join("; "),
          remediation: "Review strings for indicators of remote endpoints, shell commands or injection APIs.",
        });
      }
      if (!findings.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: `No binary findings: format=${summary.identity.format}, entropy=${summary.entropy.toFixed(2)}`, evidence };
      }
      const top = findings[0]!;
      return {
        hypothesisId: hyp.id,
        status: "confirmed",
        claim: hyp.claim,
        detail: `${findings.length} binary finding(s): ${findings.map((f) => f.title).join("; ")}`,
        evidence,
        finding: { ...top, detail: findings.map((f) => f.detail).join(" | ") },
      };
    },
  };
}
