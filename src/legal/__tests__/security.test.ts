import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { clearMattersKey, FieldCipher, LegalKeyUnavailableError, processKeyProvider, setMattersKey, StaticKeyProvider } from "../crypto.js";
import { decideEgress, isLoopbackUrl, resolveLegalRunModel, type EgressConfig } from "../egress.js";
import { MattersStore } from "../mattersStore.js";
import { redactForCloud, restore } from "../redact.js";
import { legalRunConfig } from "../runConfig.js";

const cfg: EgressConfig = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const key = (): StaticKeyProvider => new StaticKeyProvider(crypto.randomBytes(32));

test("FieldCipher: round trip, AAD binding and tamper detection", () => {
  const c = new FieldCipher(key());
  const env = c.seal("سرّي للغاية", "matter:1");
  assert.equal(c.open(env, "matter:1"), "سرّي للغاية");
  assert.throws(() => c.open(env, "matter:2"), "row id is bound as AAD");
  const parts = env.split(".");
  const ct = Buffer.from(parts[3] ?? "", "base64");
  ct[0] = (ct[0] ?? 0) ^ 1;
  assert.throws(() => c.open([parts[0], parts[1], parts[2], ct.toString("base64")].join("."), "matter:1"));
  assert.throws(() => new StaticKeyProvider(Buffer.alloc(16)));
});

test("processKeyProvider fails closed until the main process hands over the key", () => {
  clearMattersKey();
  assert.throws(() => processKeyProvider.key(), LegalKeyUnavailableError);
  setMattersKey(crypto.randomBytes(32));
  assert.equal(processKeyProvider.key().length, 32);
  clearMattersKey();
});

test("matters store keeps client text encrypted at rest", () => {
  const store = new MattersStore(":memory:", key());
  const m = store.createMatter({ title: "دعوى شركة الاختبار ضد المثال", kind: "contract_review", parties: [{ role: "client", name: "شركة الاختبار", identifiers: ["28463400123"] }] }, "user");
  const c = store.addContract(m.id, { fileName: "عقد.txt", mime: "text/plain", text: "يلتزم الطرف الثاني بسداد مبلغ 999,111 ريال", language: "ar" }, "user");
  const dump = JSON.stringify([
    store.db.prepare("SELECT * FROM matters").all(), store.db.prepare("SELECT * FROM contracts").all(), store.db.prepare("SELECT * FROM audit_log").all(),
  ]);
  for (const secret of ["شركة الاختبار", "28463400123", "999,111", "دعوى"]) assert.ok(!dump.includes(secret), `"${secret}" must not be stored in clear`);
  assert.equal(store.getContract(c.id)?.text.includes("999,111"), true);
  assert.equal(m.egress, "local_only");
  assert.equal(m.confidentiality, "confidential");
  store.close();
});

test("egress can only be widened via the UI path and is audited", () => {
  const store = new MattersStore(":memory:", key());
  const m = store.createMatter({ title: "م", kind: "research" }, "user");
  assert.throws(() => store.updateMatter(m.id, { egress: "cloud_full" }, "agent", false), /only be changed by the user/);
  const u = store.updateMatter(m.id, { egress: "cloud_redacted" }, "user", true);
  assert.equal(u.egress, "cloud_redacted");
  assert.ok(store.audit.list({ matterId: m.id }).some((e) => e.action === "egress.decision" && e.details.egress === "local_only->cloud_redacted"));
  store.close();
});

test("audit log: metadata only, append-only, hash chain detects tampering", () => {
  const store = new MattersStore(":memory:", key());
  store.audit.append("user", "search", null, "s1", { hits: 3 });
  store.audit.append("user", "search", null, "s2", { hits: 4 });
  assert.equal(store.audit.verifyChain(), null);
  assert.throws(() => store.audit.append("user", "search", null, "s", { text: "x".repeat(500) }));
  assert.throws(() => store.db.exec("UPDATE audit_log SET subject='x' WHERE seq=1"), "append-only trigger");
  assert.throws(() => store.db.exec("DELETE FROM audit_log WHERE seq=1"), "append-only trigger");
  store.db.exec("DROP TRIGGER audit_no_update");
  store.db.exec("UPDATE audit_log SET subject='forged' WHERE seq=1");
  assert.equal(store.audit.verifyChain(), 1);
  store.close();
});

test("retention purge removes expired matters and keeps the audit trail", () => {
  const store = new MattersStore(":memory:", key(), () => new Date("2092-03-01T08:00:00Z"));
  const old = store.createMatter({ title: "قديم", kind: "research", retainUntil: "2092-02-01" }, "user");
  const keep = store.createMatter({ title: "حالي", kind: "research", retainUntil: null }, "user");
  assert.deepEqual(store.purgeExpired("system"), [old.id]);
  assert.equal(store.getMatter(old.id), undefined);
  assert.ok(store.getMatter(keep.id));
  assert.ok(store.audit.list({ matterId: old.id }).some((e) => e.action === "purge"));
  store.close();
});

test("redaction replaces parties and identifiers consistently and restores", () => {
  const text = "تلتزم شركة الاختبار (س.ت 123456) بالدفع إلى IBAN QA58DOHB00001234567890ABCDEFG، رقم الهوية 28463400123، هاتف +974 5512 3456، بريد a.b@example.qa. وتكرر: وشركة الاختبار ولشركة الاختبار.";
  const r = redactForCloud(text, [{ role: "client", name: "شركة الاختبار", identifiers: [] }]);
  for (const s of ["شركة الاختبار", "28463400123", "QA58DOHB", "a.b@example.qa", "5512"]) assert.ok(!r.text.includes(s), s);
  assert.equal(r.text.split("[طرف-1]").length - 1, 3, "same party -> same placeholder, also after attached prefixes");
  assert.ok(r.text.includes("و[طرف-1]") && r.text.includes("ل[طرف-1]"));
  assert.equal(restore(r.text, r.map), text);
});

test("egress rules: approved local, cloud opt-in, privileged, loopback", () => {
  const conf = { confidentiality: "confidential", egress: "local_only" } as const;
  assert.equal(decideEgress(conf, "qwen3.6:35b-a3b", "contract_text", cfg).allow, true);
  assert.equal(decideEgress(conf, "llama3:8b", "contract_text", cfg).allow, false, "unapproved local model");
  assert.equal(decideEgress(conf, "glm-5.3-flash:cloud", "contract_text", cfg).allow, false);
  assert.equal(decideEgress(conf, "glm-5.3-flash:cloud", "law_text", cfg).allow, true, "public law text may go to cloud");
  assert.equal(decideEgress(null, "glm-5.3-flash:cloud", "matter_text", cfg).allow, false);
  const red = decideEgress({ confidentiality: "confidential", egress: "cloud_redacted" }, "glm-5.3-flash:cloud", "contract_text", cfg);
  assert.ok(red.allow && red.redact);
  assert.equal(decideEgress({ confidentiality: "privileged", egress: "cloud_redacted" }, "glm-5.3-flash:cloud", "contract_text", cfg).allow, false);
  assert.equal(decideEgress(conf, "qwen3.6:35b-a3b", "contract_text", { ...cfg, ollamaUrl: "http://10.0.0.5:11434" }).allow, false, "remote Ollama is not local");
  assert.equal(isLoopbackUrl("http://[::1]:11434"), true);
  assert.throws(() => resolveLegalRunModel(conf, "glm-5.3-flash:cloud", { ...cfg, ollamaUrl: "http://10.0.0.5:11434" }));
});

test("legal run config closes every silent model switch", () => {
  const base = {
    model: "glm-5.3-flash:cloud", fallbackModel: "qwen2.5:14b", ollamaUrl: "http://127.0.0.1:11434",
    failover: { providers: [{ id: "ollama", model: "glm-5.3:cloud", enabled: true }, { id: "opencode-go", model: "opencode-go", enabled: true }] },
    coding: { enabled: true, chain: ["x"], logEdits: true },
    routing: { perTool: { web_search: "glm-5.3:cloud" }, effort: { max: "glm-5.3:cloud" } },
    memory: { enabled: true, model: "nomic-embed-text:latest", autoStore: true },
  };
  const plan = legalRunConfig(base, "glm-5.3-flash:cloud", { confidentiality: "confidential", egress: "local_only" }, cfg);
  assert.equal(plan.model, "qwen3.6:35b-a3b");
  assert.equal(plan.cfg.model, "qwen3.6:35b-a3b");
  assert.equal(plan.cfg.fallbackModel, "qwen3.6:35b-a3b");
  assert.ok(plan.cfg.failover?.providers.every((p) => !p.enabled));
  assert.equal(plan.cfg.coding?.enabled, false);
  assert.deepEqual(plan.cfg.routing, { perTool: {}, effort: {} });
  assert.deepEqual(plan.abModels, []);
  assert.equal(plan.captureMemory, false);
  assert.equal(plan.cfg.memory.autoStore, false);
  assert.equal(base.model, "glm-5.3-flash:cloud", "input config not mutated");
});

test("legal runtime: unknown task model is treated as cloud; config normalizes to safe defaults", async () => {
  const { createLegalRuntime } = await import("../runtime.js");
  const { normalizeLegalConfig, DEFAULT_LEGAL_CONFIG } = await import("../config.js");
  const conf = normalizeLegalConfig({ enabled: true, corpusPath: ":memory:", mattersPath: ":memory:", rerank: "bogus", approvedLocalModels: "x" });
  assert.equal(conf.rerank, "off");
  assert.deepEqual(conf.approvedLocalModels, DEFAULT_LEGAL_CONFIG.approvedLocalModels);
  assert.equal(normalizeLegalConfig({}).enabled, false);
  const rt = createLegalRuntime({ dataDir: "/nonexistent", config: conf, ollamaUrl: "http://127.0.0.1:11434", keys: key() });
  const unknown = rt.toolDeps.runModelFor("t-unknown");
  assert.equal(decideEgress({ confidentiality: "internal", egress: "cloud_full" }, unknown, "contract_text", rt.egress).allow, false, "unregistered run never sees client text");
  rt.runModels.set("t1", "qwen3.6:35b-a3b");
  assert.equal(rt.toolDeps.runModelFor("t1"), "qwen3.6:35b-a3b");
  rt.close();
  const fakeEmbedder = { embed: async (texts: string[]) => texts.map(() => [0]) } as unknown as NonNullable<Parameters<typeof createLegalRuntime>[0]["embedder"]>;
  const notApproved = createLegalRuntime({ dataDir: "/nonexistent", config: { ...conf, embedModel: "nomic-embed-text:latest" }, ollamaUrl: "http://127.0.0.1:11434", keys: key(), embedder: fakeEmbedder });
  assert.equal(notApproved.toolDeps.embedder, undefined, "an embedding model outside approvedLocalModels is never used");
  notApproved.close();
  const approved = createLegalRuntime({ dataDir: "/nonexistent", config: { ...conf, embedModel: "qwen3.6:35b-a3b" }, ollamaUrl: "http://127.0.0.1:11434", keys: key(), embedder: fakeEmbedder });
  assert.equal(approved.toolDeps.embedModel, "qwen3.6:35b-a3b");
  approved.close();
});

test("key handoff: requests the key, accepts only a well-formed response", async () => {
  const { requestMattersKey, KEY_REQUEST, KEY_RESPONSE } = await import("../keyHandoff.js");
  clearMattersKey();
  assert.equal(requestMattersKey(null), false, "no parent port outside Electron");
  const sent: unknown[] = [];
  let listener: ((e: { data: unknown }) => void) | undefined;
  let ready = 0;
  const port = { on: (_e: "message", l: (e: { data: unknown }) => void) => { listener = l; }, postMessage: (m: unknown) => { sent.push(m); } };
  assert.equal(requestMattersKey(port, () => { ready++; }), true);
  assert.deepEqual(sent, [{ type: KEY_REQUEST }]);
  listener?.({ data: { type: KEY_RESPONSE, key: "zz" } });
  assert.throws(() => processKeyProvider.key(), LegalKeyUnavailableError, "malformed key ignored");
  listener?.({ data: { type: KEY_RESPONSE, key: "ab".repeat(32) } });
  assert.equal(processKeyProvider.key().toString("hex"), "ab".repeat(32));
  assert.equal(ready, 1);
  clearMattersKey();
});

test("electron key module: DPAPI-wrapped key file is created once and reused", async () => {
  const { createRequire } = await import("node:module");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const req = createRequire(import.meta.url);
  const mod = req("../../../electron/legal-key.cjs") as { loadOrCreateKeyHex(app: unknown, s: unknown): string; attachLegalKey(c: unknown, a: unknown, s: unknown): void };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-key-"));
  const app = { getPath: () => dir };
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`W:${s}`), decryptString: (b: Buffer) => b.toString().slice(2) };
  const k1 = mod.loadOrCreateKeyHex(app, fakeSafe);
  const k2 = mod.loadOrCreateKeyHex(app, fakeSafe);
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(k1, k2);
  assert.ok(fs.readFileSync(path.join(dir, "legal", ".matters-key.dpapi")).toString().startsWith("W:"), "only the wrapped form is on disk");
  assert.throws(() => mod.loadOrCreateKeyHex(app, { ...fakeSafe, isEncryptionAvailable: () => false }));
  const replies: unknown[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  mod.attachLegalKey({ on: (_e: string, l: (m: unknown) => void) => { onMsg = l; }, postMessage: (m: unknown) => replies.push(m) }, app, fakeSafe);
  onMsg?.({ type: "loam:legal-key-request" });
  assert.deepEqual(replies, [{ type: "loam:legal-key", key: k1 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
