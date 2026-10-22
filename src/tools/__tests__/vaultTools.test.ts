/**
 * Tests for vault_ref + vault reference substitution.
 *
 * Guarantees under test:
 *  - vault_ref lists secret NAMES only, never values
 *  - vault_ref returns the {{vault:NAME}} reference for an existing secret
 *  - vault_ref reports a missing secret and points at the vault UI
 *  - resolveVaultRefs substitutes values and throws on unknown names
 *  - redactVaultValues round-trips a resolved value back to [vault:NAME]
 *  - shell_run injects the value into the child env and never returns it raw
 *
 * The data directory is isolated: MANUS_LOCAL_DATA_DIR is set BEFORE the vault
 * module (which reads DATA_DIR at import time) is dynamically imported.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

const SCOPE = "agent_test";
const API_VALUE = "sk-live-vault-secret-VALUE-123";

interface VaultApi {
  createVaultTools: () => Array<{ name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ ok: boolean; content: string }> }>;
  resolveVaultRefs: (text: string, scope: string) => { text: string; secrets: string[] };
  redactVaultValues: (output: string, secrets: string[]) => string;
  vaultRef: (name: string) => string;
}

interface VaultStoreApi {
  setSecret: (agentId: string, name: string, value: string) => true | { error: string };
}

interface ShellApi {
  shellTools: Array<{ name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ ok: boolean; content: string }> }>;
}

let tmpDir = "";
let vault: VaultApi;
let store: VaultStoreApi;
let shell: ShellApi;

function ctx(workspace: string, agentId: string = SCOPE): unknown {
  return {
    cfg: { policy: { denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 180 } },
    workspace,
    agentId,
    emit: () => {},
  };
}

describe("vault_ref + vault reference substitution", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vault-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const vaultModule = (await import("../vaultTools.js")) as unknown as VaultApi;
    const storeModule = (await import("../../server/secretsVault.js")) as unknown as VaultStoreApi;
    const shellModule = (await import("../shell.js")) as unknown as ShellApi;
    vault = vaultModule;
    store = storeModule;
    shell = shellModule;
    assert.equal(store.setSecret(SCOPE, "API_KEY", API_VALUE), true);
    assert.equal(store.setSecret(SCOPE, "DB_PASSWORD", "hunter2-value"), true);
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const tool = () => vault.createVaultTools().find((t) => t.name === "vault_ref")!;
  const shellRun = () => shell.shellTools.find((t) => t.name === "shell_run")!;

  it("lists secret names without ever returning values", async () => {
    const res = await tool().run({}, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.match(res.content, /API_KEY/);
    assert.match(res.content, /DB_PASSWORD/);
    assert.ok(!res.content.includes(API_VALUE), "value must never appear in the listing");
    assert.ok(!res.content.includes("hunter2-value"), "value must never appear in the listing");
  });

  it("returns the reference string for an existing secret", async () => {
    const res = await tool().run({ name: "API_KEY" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.match(res.content, /\{\{vault:API_KEY\}\}/);
    assert.match(res.content, /shell_run/);
    assert.ok(!res.content.includes(API_VALUE), "value must never appear");
  });

  it("reports a missing secret and points at the vault UI", async () => {
    const res = await tool().run({ name: "NOPE" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /NOPE/);
    assert.match(res.content, /vault UI/i);
  });

  it("rejects an invalid secret name", async () => {
    const res = await tool().run({ name: "bad name!" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /invalid vault secret name/);
  });

  it("resolves refs and throws a clear error on an unknown name", () => {
    const { text, secrets } = vault.resolveVaultRefs("key={{vault:API_KEY}}", SCOPE);
    assert.equal(text, `key=${API_VALUE}`);
    assert.deepEqual(secrets, [API_VALUE]);

    assert.throws(() => vault.resolveVaultRefs("{{vault:MISSING}}", SCOPE), /MISSING/);
  });

  it("redacts resolved values back to [vault:NAME]", () => {
    const { text, secrets } = vault.resolveVaultRefs("a={{vault:API_KEY}} b={{vault:DB_PASSWORD}}", SCOPE);
    const redacted = vault.redactVaultValues(text, secrets);
    assert.equal(redacted, "a=[vault:API_KEY] b=[vault:DB_PASSWORD]");
    assert.ok(!redacted.includes(API_VALUE));
    assert.ok(!redacted.includes("hunter2-value"));
  });

  it("vaultRef builds the reference string", () => {
    assert.equal(vault.vaultRef("API_KEY"), "{{vault:API_KEY}}");
  });

  it("shell_run injects the value into the child env and never returns it raw", async () => {
    const res = await shellRun().run(
      { command: 'node -e "console.log(process.env.PROBE)"', env: { PROBE: "{{vault:API_KEY}}" } },
      ctx(tmpDir),
    );
    assert.equal(res.ok, true);
    assert.ok(!res.content.includes(API_VALUE), "raw value must not appear in returned content");
    assert.match(res.content, /\[vault:API_KEY\]/);
  });

  it("shell_run rewrites command refs to env-var references instead of inlining", async () => {
    const res = await shellRun().run({ command: "echo {{vault:API_KEY}}" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.ok(!res.content.includes(API_VALUE), "value must not be inlined into the command");
    if (process.platform === "win32") {
      // cmd.exe cannot expand $env:, so the literal reference proves the rewrite.
      assert.match(res.content, /\$env:LOAM_VAULT_API_KEY/);
    } else {
      assert.match(res.content, /\[vault:API_KEY\]/);
    }
  });

  it("shell_run fails clearly when a referenced secret is missing", async () => {
    const res = await shellRun().run({ command: "echo {{vault:MISSING}}" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /MISSING/);
  });

  it("shell_run still runs plain commands unchanged", async () => {
    const res = await shellRun().run({ command: "echo plain-ok" }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.match(res.content, /plain-ok/);
  });
});
