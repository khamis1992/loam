/** Schema for findings.json: a top-level array of oneOf(confirmed, needs_validation, rejected). */
import { text, strArr } from "./schema.js";
import type { SchemaObject } from "./schema.js";
import { CONDITION_KINDS, SCORES } from "./types.js";

export const FINGERPRINT_RE = "^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$";
const fingerprint = (): SchemaObject => ({ type: "string", minLength: 1, pattern: FINGERPRINT_RE });
const line = (): SchemaObject => ({ type: "integer", minimum: 1 });
const score = (): SchemaObject => ({ type: "string", enum: [...SCORES] });
const assurance = (): SchemaObject => ({ type: "string", enum: ["full", "reduced-win32", "source-only"] });

const obj = (properties: Record<string, SchemaObject>, required: string[]): SchemaObject => ({
  type: "object", properties, required, additionalProperties: false,
});
const arr = (items: SchemaObject, minItems = 0): SchemaObject => ({ type: "array", items, minItems });

export const traceStep = (): SchemaObject =>
  obj({
    kind: { type: "string", enum: ["entrypoint", "propagation", "sink"] },
    file: text(), line: line(), scope: text(), description: text(),
  }, ["kind", "file", "line", "scope", "description"]);

export const evidenceItem = (): SchemaObject =>
  obj({ file: text(), line: line(), description: text() }, ["file", "line", "description"]);

const evidenceVectorItem = (): SchemaObject =>
  obj({
    source: { type: "string", enum: ["dyn", "llm", "rule"] },
    state: { type: "string", enum: ["confirmed", "refuted", "unknown"] },
    ref: text(), note: text(),
  }, ["source", "state", "ref"]);

const proof = (): SchemaObject =>
  obj({
    kind: { type: "string", enum: ["poc", "crash", "render", "diff"] },
    artifact_rel: text(), sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, observed: text(),
  }, ["kind", "artifact_rel", "sha256", "observed"]);

const cvss = (): SchemaObject =>
  obj({ vector: text(), score: { type: "number", minimum: 0 }, severity: score() }, ["vector", "score", "severity"]);

const scored = (): SchemaObject => obj({ score: score(), reason: text() }, ["score", "reason"]);

const confirmed = (): SchemaObject =>
  obj({
    verdict: { const: "confirmed" }, fingerprint: fingerprint(), title: text(), description: text(),
    root_cause: text(), intended_behavior: text(),
    trace: arr(traceStep(), 1), evidence: arr(evidenceItem(), 1),
    conditions: arr(obj({ kind: { type: "string", enum: [...CONDITION_KINDS] }, description: text() }, ["kind", "description"])),
    execution: obj({
      attacker_perspective: text(), payloads: strArr(0), instructions: strArr(0), observed_result: text(),
    }, ["attacker_perspective", "payloads", "instructions", "observed_result"]),
    remediation: obj({
      strategy: text(),
      code_changes: arr(obj({ file_name: text(), fixed_code: text() }, ["file_name", "fixed_code"])),
    }, ["strategy"]),
    severity: obj({ likelihood: scored(), impact: scored(), overall_severity: score() }, ["likelihood", "impact", "overall_severity"]),
    confidence: obj({ score: { type: "string", enum: ["low", "medium", "high"] }, reason: text() }, ["score", "reason"]),
    evidence_vector: arr(evidenceVectorItem(), 1),
    evidence_assurance: assurance(),
    proof: proof(),
    production_viable: { type: ["boolean", "string"], enum: [true, false, "unknown"] },
    cvss: cvss(),
  }, [
    "verdict", "fingerprint", "title", "description", "root_cause", "intended_behavior", "trace", "evidence",
    "conditions", "execution", "remediation", "severity", "confidence", "evidence_vector", "evidence_assurance",
  ]);

const needsValidation = (): SchemaObject =>
  obj({
    verdict: { const: "needs_validation" }, fingerprint: fingerprint(), title: text(), description: text(),
    claimed_root_cause: text(), trace: arr(traceStep(), 1), evidence: arr(evidenceItem(), 1),
    blockers: strArr(1),
    validation_plan: obj({ local: text(), deployment: text() }, []),
    evidence_vector: arr(evidenceVectorItem(), 1),
    evidence_assurance: assurance(),
  }, [
    "verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence",
    "blockers", "validation_plan", "evidence_vector", "evidence_assurance",
  ]);

const rejected = (): SchemaObject =>
  obj({
    verdict: { const: "rejected" }, fingerprint: fingerprint(), title: text(), description: text(),
    claimed_root_cause: text(), trace: arr(traceStep(), 1), evidence: arr(evidenceItem(), 1), reason: text(),
    evidence_assurance: assurance(),
  }, ["verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence", "reason", "evidence_assurance"]);

export const FINDINGS_SCHEMA: SchemaObject = { type: "array", items: { oneOf: [confirmed(), needsValidation(), rejected()] } };
