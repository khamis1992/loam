import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { validateAnchor } from "../evidence/anchors.js";
import { importMatterDocument } from "../evidence/service.js";
import { LegalFileVault } from "../security/fileVault.js";

test("document import builds encrypted evidence, timeline and contradiction candidates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-evidence-"));
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(path.join(dir, "matters.db"), keys);
  const matter = store.createMatter({ title: "قضية اختبار", kind: "defense_memo" }, "user");
  const source = path.join(dir, "case.txt");
  fs.writeFileSync(source, "المبلغ 1000 ريال بتاريخ 2024/01/15.\nالمبلغ 2000 ريال في ملحق لاحق.");
  const analysis = await importMatterDocument(store, matter.id, source, { now: () => new Date("2026-10-26T00:00:00Z") });
  assert.equal(analysis.facts.length, 2);
  assert.equal(analysis.timeline[0]?.sortDate, "2024-01-15");
  assert.equal(analysis.contradictions[0]?.severity, "warning");
  assert.equal(validateAnchor(analysis.facts[0]!.anchors[0]!, analysis.document), true);
  const dump = JSON.stringify(store.db.prepare("SELECT * FROM evidence_documents").all());
  assert.equal(dump.includes("1000"), false);
  assert.equal(dump.includes("ريال"), false);
  assert.equal(store.evidence.getDocument(analysis.document.id)?.text.includes("1000"), true);
  assert.throws(() => store.evidence.saveTimeline([{ ...analysis.timeline[0]!, matterId: "missing" }]));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file vault stores encrypted originals and round trips bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-vault-"));
  const vault = new LegalFileVault(dir, new StaticKeyProvider(crypto.randomBytes(32)));
  const bytes = Buffer.from("original client bytes 12345", "utf8");
  const stored = vault.put(bytes);
  assert.equal(fs.readdirSync(dir).some((file) => fs.readFileSync(path.join(dir, file), "utf8").includes("12345")), false);
  assert.deepEqual(vault.get(stored.id), bytes);
  assert.equal(vault.delete(stored.id), true);
  assert.equal(vault.delete(stored.id), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
