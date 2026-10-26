import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FieldCipher, StaticKeyProvider } from "../crypto.js";
import { migrateLegalDatabase } from "../db/migrations.js";
import { createLegalModelPort } from "../model/legalModelPort.js";
import { createLegalBackup, restoreLegalBackup } from "../security/backup.js";
import { openLegalPayload, sealLegalPayload } from "../security/transcriptSeal.js";
import { MattersStore } from "../mattersStore.js";
import type { ChatResult } from "../../ollama.js";

const keys = (): StaticKeyProvider => new StaticKeyProvider(crypto.randomBytes(32));
const result = (model: string): ChatResult => ({ content: "{}", model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } });

test("sealed legal payload round trips and refuses a foreign envelope", () => {
  const cipher = new FieldCipher(keys());
  const sealed = sealLegalPayload(cipher, { type: "tool_result", text: "شركة الاختبار" }, "step|task|1");
  assert.notEqual(JSON.stringify(sealed).includes("شركة الاختبار"), true);
  assert.deepEqual(openLegalPayload(cipher, sealed), { type: "tool_result", text: "شركة الاختبار" });
  assert.throws(() => openLegalPayload(cipher, { type: "tool_result" }));
});

test("legal model port blocks unapproved requests and provider model switches", async () => {
  const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
  const calls: string[] = [];
  const client = { chat: async (opts: { model: string }) => { calls.push(opts.model); return result(opts.model); } };
  const { port } = createLegalModelPort({ config, client });
  await assert.rejects(port({ model: "glm:cloud", messages: [] }), /blocked/);
  assert.deepEqual(calls, []);
  const ok = await port({ model: config.localModel, messages: [] });
  assert.equal(ok.model, config.localModel);
  const switched = createLegalModelPort({ config, client: { chat: async () => result("glm:cloud") } });
  await assert.rejects(switched.port({ model: config.localModel, messages: [] }), /unapproved model/);
  assert.throws(() => createLegalModelPort({ config: { ...config, ollamaUrl: "http://10.0.0.2:11434" } }), /not approved|loopback/);
});

test("legal migrations initialize, upgrade and reject a newer schema", () => {
  const db = new DatabaseSync(":memory:");
  const schema = "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE items(id TEXT PRIMARY KEY);";
  const migration = { schema, version: 1, migrations: [{ version: 2, sql: "ALTER TABLE items ADD COLUMN note TEXT;" }] };
  migrateLegalDatabase(db, migration);
  migrateLegalDatabase(db, migration);
  assert.deepEqual(db.prepare("PRAGMA table_info(items)").all().map((r) => r.name), ["id", "note"]);
  db.exec("PRAGMA user_version=99");
  assert.throws(() => migrateLegalDatabase(db, migration), /newer/);
  db.close();
});

test("legal backup restores encrypted matters with the recovery passphrase", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-backup-"));
  const mattersPath = path.join(dir, "matters.db");
  const corpusPath = path.join(dir, "qatar-law.db");
  const outputPath = path.join(dir, "backup.loam-legal");
  const provider = keys();
  const store = new MattersStore(mattersPath, provider);
  const matter = store.createMatter({ title: "شركة الاختبار", kind: "research" }, "user");
  store.close();
  fs.writeFileSync(corpusPath, "public corpus fixture");
  createLegalBackup({ outputPath, mattersPath, corpusPath, keys: provider, passphrase: "correct horse battery" });
  assert.equal(fs.readFileSync(outputPath, "utf8").includes("شركة الاختبار"), false);
  assert.throws(() => restoreLegalBackup({ inputPath: outputPath, mattersPath, corpusPath, passphrase: "wrong passphrase" }));
  const restoredMatters = path.join(dir, "restored-matters.db");
  const restoredCorpus = path.join(dir, "restored-corpus.db");
  const restored = restoreLegalBackup({ inputPath: outputPath, mattersPath: restoredMatters, corpusPath: restoredCorpus, passphrase: "correct horse battery" });
  const reopened = new MattersStore(restoredMatters, new StaticKeyProvider(restored.mattersKey));
  assert.equal(reopened.getMatter(matter.id)?.title, "شركة الاختبار");
  reopened.close();
  assert.equal(fs.readFileSync(restoredCorpus, "utf8"), "public corpus fixture");
  fs.rmSync(dir, { recursive: true, force: true });
});
