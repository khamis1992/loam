import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before } from "node:test";
import type { Config } from "../../config.js";

const fixtureCfg = { model: "big-model", fallbackModel: "small-model" } as unknown as Config;

let tmpDir = "";

describe("model tiers (option 18)", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-tiers-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  });

  it("maps tiers to concrete ids from existing config/settings defaults", async () => {
    const { resolveTierModel } = await import("../modelTiers.js");
    assert.deepEqual(resolveTierModel(fixtureCfg, "max"), { model: "big-model", flex: false });
    assert.equal(resolveTierModel(fixtureCfg, "lite").model, "small-model");
    // standard falls back to cfg.model while no user model is stored.
    assert.equal(resolveTierModel(fixtureCfg, "standard").model, "big-model");
    const { updateSettings } = await import("../settings.js");
    updateSettings({ model: "user-model" });
    assert.equal(resolveTierModel(fixtureCfg, "standard").model, "user-model");
  });

  it("flex stores the key encrypted and never returns it", async () => {
    const { setFlexConfig, flexConfig, resolveTierModel, flexCredentials } = await import("../modelTiers.js");
    // Unconfigured flex resolves to the default model, not a cloud id.
    assert.deepEqual(resolveTierModel(fixtureCfg, "flex"), { model: "big-model", flex: false });
    const res = setFlexConfig({ key: "sk-SECRET-123", baseUrl: "https://provider.example/v1", model: "their-model" });
    assert.ok(!("error" in res), "setFlexConfig should succeed");
    const pub = flexConfig();
    assert.equal(pub.baseUrl, "https://provider.example/v1");
    assert.equal(pub.model, "their-model");
    assert.equal(pub.hasKey, true);
    assert.ok(!JSON.stringify(pub).includes("sk-SECRET-123"), "public config must not contain the key");
    const tier = resolveTierModel(fixtureCfg, "flex");
    assert.equal(tier.model, "their-model:cloud");
    assert.equal(tier.flex, true);
    const creds = flexCredentials();
    assert.ok(creds && creds.apiKey === "sk-SECRET-123");
  });

  it("rejects non-http base urls and clears the key on empty string", async () => {
    const { setFlexConfig, flexConfig, clearFlexKey, flexCredentials } = await import("../modelTiers.js");
    assert.ok("error" in setFlexConfig({ baseUrl: "ftp://x" }));
    setFlexConfig({ key: "" });
    assert.equal(flexConfig().hasKey, false);
    assert.equal(flexCredentials(), null);
    // re-store, then clear via clearFlexKey
    setFlexConfig({ key: "sk-again" });
    assert.equal(flexConfig().hasKey, true);
    assert.equal(clearFlexKey(), true);
    assert.equal(flexConfig().hasKey, false);
  });
});
