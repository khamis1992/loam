import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let apiKeys: typeof import("../apiKeys.js");
let sqlite: typeof import("../sqliteStore.js");

describe("api keys", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-apikeys-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    apiKeys = await import("../apiKeys.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates a key, shows it once and stores only its hash", () => {
    const created = apiKeys.createApiKey("CI key");
    assert.ok(created.key.startsWith("lm_live_"));
    assert.equal(typeof created.id, "string");
    assert.equal(created.name, "CI key");
    assert.ok(created.prefix.length > "lm_live_".length);

    // The listing must never contain the raw key or its hash.
    const listed = apiKeys.listApiKeys();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, created.id);
    assert.equal(listed[0]!.name, "CI key");
    assert.equal(listed[0]!.prefix, created.prefix);
    assert.ok(!("key" in listed[0]!));

    // Nothing in the on-disk database equals the raw key.
    const dbText = fs.readFileSync(path.join(tmpDir, "manus.db"), "utf8");
    assert.ok(!dbText.includes(created.key));
  });

  it("verifies a valid key and stamps lastUsedAt", () => {
    const created = apiKeys.createApiKey("second");
    const record = apiKeys.verifyApiKey(created.key);
    assert.ok(record);
    assert.equal(record.id, created.id);
    assert.ok(record.lastUsedAt);
    const listed = apiKeys.listApiKeys().find((k) => k.id === created.id);
    assert.ok(listed?.lastUsedAt);
  });

  it("rejects malformed, unknown and revoked keys", () => {
    assert.equal(apiKeys.verifyApiKey("not-a-key"), undefined);
    assert.equal(apiKeys.verifyApiKey("lm_live_wrong"), undefined);

    const created = apiKeys.createApiKey("doomed");
    assert.ok(apiKeys.revokeApiKey(created.id));
    assert.equal(apiKeys.verifyApiKey(created.key), undefined);
    const listed = apiKeys.listApiKeys().find((k) => k.id === created.id);
    assert.ok(listed?.revokedAt);
    // Revoking twice does not report a second change.
    assert.equal(apiKeys.revokeApiKey(created.id), false);
  });

  it("supports multiple keys with distinct identities", () => {
    const a = apiKeys.createApiKey("a");
    const b = apiKeys.createApiKey("b");
    assert.notEqual(a.key, b.key);
    assert.equal(apiKeys.verifyApiKey(a.key)!.name, "a");
    assert.equal(apiKeys.verifyApiKey(b.key)!.name, "b");
    assert.equal(apiKeys.listApiKeys().length, 5);
  });
});