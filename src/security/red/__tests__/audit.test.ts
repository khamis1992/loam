/**
 * Red-team append-only audit log tests (spec §5.2).
 *
 * One entry per target-touching action, secrets redacted, the log is never
 * truncated by the app and rotation is copy-then-seal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RedAuditLog, redactParams } from "../audit.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-audit-"));

describe("redactParams", () => {
  it("masks secret-ish keys only", () => {
    const out = redactParams({
      url: "http://127.0.0.1:3000/login",
      cookie: "session=abc123",
      Authorization: "Bearer xyz",
      api_key: "k1",
      normalValue: 7,
    });
    assert.equal(out.url, "http://127.0.0.1:3000/login");
    assert.equal(out.cookie, "[REDACTED]");
    assert.equal(out.Authorization, "[REDACTED]");
    assert.equal(out.api_key, "[REDACTED]");
    assert.equal(out.normalValue, 7);
  });
});

describe("RedAuditLog", () => {
  it("appends monotonically-numbered entries and never rewrites history", () => {
    const root = tempRoot();
    const log = new RedAuditLog(root);
    const e1 = log.append({ authzId: null, capability: "red.recon", action: "gate", target: "http://127.0.0.1:3000/", params: {}, outcome: "allowed" });
    const e2 = log.append({ authzId: "AUTHZ-0001", capability: "red.sqli", action: "bridge", target: "http://127.0.0.1:3000/item?id=1", params: { cookie: "a=b" }, outcome: "completed", evidenceIds: ["EV0001"] });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.ok(e1.at <= e2.at);
    assert.ok(fs.existsSync(path.join(root, "audit", "red-audit.jsonl")));

    // A second log instance over the same root continues the sequence (never restarts).
    const reopened = new RedAuditLog(root);
    const e3 = reopened.append({ authzId: null, capability: "red.recon", action: "gate", target: "t", params: {}, outcome: "denied", reason: "kill-switch engaged" });
    assert.equal(e3.seq, 3);
  });

  it("read() returns every entry in order, with params redacted on append", () => {
    const root = tempRoot();
    const log = new RedAuditLog(root);
    log.append({ authzId: null, capability: "c", action: "a", target: "t", params: { token: "sekret" }, outcome: "allowed" });
    const entries = log.read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.params.token, "[REDACTED]");
  });

  it("seal() archives history copy-then-seal: archives are never truncated", () => {
    const root = tempRoot();
    const log = new RedAuditLog(root);
    log.append({ authzId: null, capability: "c", action: "a", target: "t1", params: {}, outcome: "allowed" });
    log.append({ authzId: null, capability: "c", action: "a", target: "t2", params: {}, outcome: "denied" });
    const archivePath = log.seal();
    assert.ok(fs.existsSync(archivePath));
    const archived = fs.readFileSync(archivePath, "utf8").trim().split("\n");
    assert.equal(archived.length, 2);
    assert.equal(log.verifyArchive(archivePath), true);
    fs.appendFileSync(archivePath, "{}\n");
    assert.equal(log.verifyArchive(archivePath), false);
    fs.writeFileSync(archivePath, archived.join("\n") + "\n");

    // Live file restarts; the archive is untouched by later appends.
    const e = log.append({ authzId: null, capability: "c", action: "a", target: "t3", params: {}, outcome: "allowed" });
    assert.equal(e.seq, 1);
    assert.equal(fs.readFileSync(archivePath, "utf8").trim().split("\n").length, 2);
  });

  it("the live file only ever grows between seals", () => {
    const root = tempRoot();
    const log = new RedAuditLog(root);
    const file = path.join(root, "audit", "red-audit.jsonl");
    log.append({ authzId: null, capability: "c", action: "a", target: "t1", params: {}, outcome: "allowed" });
    const size1 = fs.statSync(file).size;
    log.append({ authzId: null, capability: "c", action: "a", target: "t2", params: {}, outcome: "allowed" });
    const size2 = fs.statSync(file).size;
    assert.ok(size2 > size1);
  });
});
