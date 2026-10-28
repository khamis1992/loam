import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FieldCipher, StaticKeyProvider } from "../crypto.js";

const TARGETS = [
  ["matters", "payload_enc", "matter"],
  ["contracts", "payload_enc", "contract"],
  ["clauses", "payload_enc", "clause"],
  ["reviews", "payload_enc", "review"],
  ["evidence_documents", "payload_enc", "evidence-document"],
  ["fact_assertions", "payload_enc", "fact"],
  ["timeline_events", "payload_enc", "timeline"],
  ["contradictions", "payload_enc", "contradiction"],
  ["pipeline_runs", "payload_enc", "pipeline"],
  ["approval_artifacts", "data_enc", "approval-artifact"],
] as const;

export function rotateMattersKey(dbPath: string, backupPath: string, oldKey: Buffer, newKey: Buffer): { records: number; backupPath: string } {
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) throw new Error("key rotation requires a closed on-disk matters database");
  if (path.resolve(dbPath) === path.resolve(backupPath)) throw new Error("key rotation backup must be a different file");
  const oldProvider = new StaticKeyProvider(oldKey);
  const newProvider = new StaticKeyProvider(newKey);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(dbPath, backupPath);
  const oldCipher = new FieldCipher(oldProvider);
  const newCipher = new FieldCipher(newProvider);
  const db = new DatabaseSync(dbPath);
  let transaction = false;
  let records = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    for (const [table, column, aadPrefix] of TARGETS) {
      const rows = db.prepare(`SELECT id, ${column} AS envelope FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ id: string; envelope: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`);
      for (const row of rows) {
        const plaintext = oldCipher.open(row.envelope, `${aadPrefix}:${row.id}`);
        update.run(newCipher.seal(plaintext, `${aadPrefix}:${row.id}`), row.id);
        records++;
      }
    }
    db.exec("COMMIT");
    transaction = false;
    return { records, backupPath };
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
