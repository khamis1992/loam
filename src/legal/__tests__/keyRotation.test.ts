import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { rotateMattersKey } from "../security/keyRotation.js";
import { createLegalBackup, restoreLegalBackup } from "../security/backup.js";
import { importMatterDocument } from "../evidence/service.js";
import { segmentContract } from "../contract/clauses.js";

test("key rotation reencrypts every stored record and restores on a new device", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-key-rotation-"));
  const dbPath = path.join(dir, "matters.db");
  const backupPath = path.join(dir, "before-rotation.db");
  const oldProvider = new StaticKeyProvider(crypto.randomBytes(32));
  const newProvider = new StaticKeyProvider(crypto.randomBytes(32));
  try {
    const store = new MattersStore(dbPath, oldProvider);
    const matter = store.createMatter({ title: "مسألة تدوير المفتاح", kind: "research" }, "user");
    const contract = store.addContract(matter.id, { fileName: "contract.txt", mime: "text/plain", text: "البند 1\nالثمن 1000 ريال", language: "ar" }, "user");
    store.saveClauses(contract.id, segmentContract(contract.id, contract.text));
    const evidencePath = path.join(dir, "evidence.txt");
    fs.writeFileSync(evidencePath, "الضرر 1000 ريال بتاريخ 2091/12/01.");
    const evidence = await importMatterDocument(store, matter.id, evidencePath);
    const before = store.db.prepare("SELECT payload_enc FROM matters WHERE id=?").get(matter.id) as { payload_enc: string };
    store.close();

    const rotation = rotateMattersKey(dbPath, backupPath, oldProvider.key(), newProvider.key());
    assert.ok(rotation.records >= 4);
    const after = new MattersStore(dbPath, newProvider);
    const rotated = after.db.prepare("SELECT payload_enc FROM matters WHERE id=?").get(matter.id) as { payload_enc: string };
    assert.notEqual(rotated.payload_enc, before.payload_enc);
    assert.equal(after.getMatter(matter.id)?.title, "مسألة تدوير المفتاح");
    assert.equal(after.getContract(contract.id)?.text.includes("1000"), true);
    assert.equal(after.evidence.listFacts(matter.id)[0]?.text.includes("1000"), true);
    after.close();
    const old = new MattersStore(dbPath, oldProvider);
    assert.throws(() => old.getMatter(matter.id));
    old.close();
    const recovery = new MattersStore(backupPath, oldProvider);
    assert.equal(recovery.getMatter(matter.id)?.title, "مسألة تدوير المفتاح");
    recovery.close();

    const corpusPath = path.join(dir, "corpus.db");
    const backupFile = path.join(dir, "rotated.loam-legal");
    fs.writeFileSync(corpusPath, "public fixture");
    createLegalBackup({ outputPath: backupFile, mattersPath: dbPath, corpusPath, keys: newProvider, passphrase: "new device passphrase" });
    const restoredPath = path.join(dir, "new-device", "matters.db");
    const restoredCorpus = path.join(dir, "new-device", "corpus.db");
    const restored = restoreLegalBackup({ inputPath: backupFile, mattersPath: restoredPath, corpusPath: restoredCorpus, passphrase: "new device passphrase" });
    const restoredStore = new MattersStore(restoredPath, new StaticKeyProvider(restored.mattersKey));
    assert.equal(restoredStore.getMatter(matter.id)?.title, "مسألة تدوير المفتاح");
    assert.equal(restoredStore.evidence.getDocument(evidence.document.id)?.text.includes("1000"), true);
    restoredStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
