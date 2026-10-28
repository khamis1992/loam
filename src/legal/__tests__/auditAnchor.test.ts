import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { exportAuditAnchor, verifyAuditAnchor, type AuditAnchor } from "../security/auditAnchor.js";

test("audit anchor is verifiable outside the audit database", () => {
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(":memory:", keys);
  store.audit.append("user", "search", null, "search", { hits: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-anchor-"));
  const anchor = exportAuditAnchor(store.audit, path.join(dir, "anchor.json"), keys, () => new Date("2092-01-01T00:00:00Z"));
  assert.equal(verifyAuditAnchor(anchor, keys), true);
  const forged: AuditAnchor = { ...anchor, hash: "f".repeat(64) };
  assert.equal(verifyAuditAnchor(forged, keys), false);
  assert.equal(verifyAuditAnchor(anchor, new StaticKeyProvider(crypto.randomBytes(32))), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
