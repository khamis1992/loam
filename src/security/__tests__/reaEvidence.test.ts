import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ReaEvidenceRecord,
  ReaIntegrityError,
  canonicalJson,
  importReaBundle,
  isReaServerEvidenceId,
  reaBundlePath,
  reaContentDigest,
  verifyReaRecord,
} from "../reaEvidence.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rea-goldens.json");
const goldens = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { records: ReaEvidenceRecord[] };

test("golden fixture: both live-exported records verify against their declared evidence ids", () => {
  assert.equal(goldens.records.length, 2);
  for (const record of goldens.records) {
    assert.ok(isReaServerEvidenceId(record.evidence_id ?? ""), `not a server id: ${record.evidence_id}`);
    assert.equal(verifyReaRecord(record), record.evidence_id);
  }
});

test("canonicalJson: sorted keys, no whitespace, array order preserved", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson("x"), '"x"');
});

test("projection excludes volatile identity: renaming subject.name/local_path keeps the digest stable", () => {
  const record = goldens.records[0]!;
  const renamed = structuredClone(record);
  renamed.subject = { ...renamed.subject, name: "totally-different", local_path: "C:/elsewhere" };
  assert.equal(reaContentDigest(renamed), record.evidence_id);
});

test("tampering any projected field is detected as integrity mismatch", () => {
  const record = goldens.records[1]!;
  for (const mutate of [
    (r: ReaEvidenceRecord) => { (r.normalized_result as Record<string, unknown>).parent_evidence_id = "ev_0000"; },
    (r: ReaEvidenceRecord) => { r.subject!.digest!.sha256 = "0".repeat(64); },
    (r: ReaEvidenceRecord) => { (r.limitations as string[]).push("extra"); },
  ]) {
    const tampered = structuredClone(record);
    mutate(tampered);
    assert.throws(() => verifyReaRecord(tampered), ReaIntegrityError);
  }
});

test("importReaBundle mints hybrid refs: fresh EV#### ids + stable contentDigest + untrusted", () => {
  let seq = 42;
  const idGen = () => `EV${String(seq++).padStart(4, "0")}`;
  const refs = importReaBundle(JSON.stringify({ records: goldens.records }), idGen);
  assert.equal(refs.length, 2);
  for (const ref of refs) {
    assert.match(ref.id, /^EV\d{4}$/);
    assert.equal(ref.kind, "rea_observation");
    assert.equal(ref.untrusted, true);
    assert.ok(isReaServerEvidenceId(ref.contentDigest ?? ""));
    assert.equal(typeof ref.rea?.operation, "string");
  }
  assert.equal(refs[0]!.id, "EV0042");
  assert.equal(refs[1]!.id, "EV0043");
});

test("importReaBundle rejects invalid JSON, non-array containers, and any tampered record", () => {
  const idGen = () => "EV0001";
  assert.throws(() => importReaBundle("{not json", idGen), ReaIntegrityError);
  assert.throws(() => importReaBundle('{"nope":1}', idGen), /no records array/);
  const tampered = structuredClone(goldens.records[0]!);
  (tampered.parameters as Record<string, unknown>).detail = "complete";
  assert.throws(() => importReaBundle(JSON.stringify({ records: [tampered] }), idGen), ReaIntegrityError);
});

test("first-party src/re 32-hex namespace is rejected, not confused with server ids", () => {
  assert.equal(isReaServerEvidenceId("ev_" + "a".repeat(32)), false);
  assert.equal(isReaServerEvidenceId("ev_" + "a".repeat(64)), true);
  const firstParty = { evidence_id: "ev_" + "a".repeat(32) } as ReaEvidenceRecord;
  assert.throws(() => verifyReaRecord(firstParty), /not a server evidence id/);
});

test("bundle paths land under .loam/rea/bundles with a sanitized digest name", () => {
  const p = reaBundlePath("C:/ws", "ev_abc123-XY");
  assert.equal(p, path.join("C:/ws", ".loam", "rea", "bundles", "ev_abc123-XY.json"));
  assert.ok(!reaBundlePath("C:/ws", "../evil").includes(".."));
});
