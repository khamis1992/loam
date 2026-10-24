/** check:rea-evidence — smoke gate for the hybrid evidence identity
 *  (REA_INTO_LOAM_INTEGRATION §6, §11; appendix A8).
 *  Proves against the embedded live-exported goldens (rea-agents@6.7.0) that:
 *  digests recompute exactly, tampering rejects, imports mint EV#### + contentDigest,
 *  and the first-party 32-hex namespace stays distinct. Offline — no MCP server. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importReaBundle, isReaServerEvidenceId, reaBundlePath, verifyReaRecord } from "../security/reaEvidence.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "security", "__tests__", "fixtures", "rea-goldens.json");
const goldens = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { records: Array<{ evidence_id?: string }> };

// 1. Every golden record verifies: clean-room digest == server-declared evidence id.
assert.ok(goldens.records.length >= 2, "golden fixture lost records");
for (const record of goldens.records) {
  assert.equal(verifyReaRecord(record as never), record.evidence_id);
}
// 2. Round-trip: bundle import mints hybrid refs (fresh EV#### + stable digest + untrusted).
let seq = 900;
const refs = importReaBundle(JSON.stringify(goldens), () => `EV${String(seq++).padStart(4, "0")}`);
assert.equal(refs.length, goldens.records.length);
for (const ref of refs) {
  assert.match(ref.id, /^EV\d{4}$/);
  assert.equal(ref.kind, "rea_observation");
  assert.equal(ref.untrusted, true);
  assert.ok(isReaServerEvidenceId(ref.contentDigest ?? ""));
}

// 3. Tamper detection on a projected field rejects the whole bundle.
const tampered = structuredClone(goldens);
((tampered.records[0]! as Record<string, unknown>).parameters as Record<string, unknown>).detail = "complete";
let rejected = false;
try { importReaBundle(JSON.stringify(tampered), () => "EV0001"); } catch { rejected = true; }
assert.equal(rejected, true, "tampered bundle must be rejected");

// 4. Bundle destination is inside the task workspace.
assert.ok(reaBundlePath("ws", refs[0]?.contentDigest ?? "").includes(path.join(".loam", "rea", "bundles")));

console.log(`PASS: check:rea-evidence — ${refs.length} golden records verified against rea-agents@6.7.0 digests, tamper rejection + hybrid EV####/contentDigest round-trip green`);
