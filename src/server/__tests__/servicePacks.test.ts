import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-service-packs-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.LOAM_CONFIG = path.join(dir, "config.json");
fs.writeFileSync(process.env.LOAM_CONFIG, JSON.stringify({ workspace: dir }));

const packs = await import("../servicePacks.js");
const capabilities = await import("../servicePackCapabilities.js");
const config = await import("../mcpConfig.js");
const sqlite = await import("../sqliteStore.js");

after(() => {
  sqlite.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("service pack catalog and installation", () => {
  it("covers every reverse-engineered capability with built-ins or installable packs", () => {
    const covered = new Set([
      ...packs.BUILT_IN_CAPABILITY_GROUPS.flatMap((group) => capabilities.SERVICE_CAPABILITY_GROUPS[group] ?? []),
      ...packs.SERVICE_PACKS.flatMap((pack) => pack.capabilities),
    ]);
    const expected = new Set(Object.values(capabilities.SERVICE_CAPABILITY_GROUPS).flat());
    assert.deepEqual(covered, expected);
    assert.equal(covered.size, 167);
  });

  it("installs a provider as a lazy MCP entry with pack metadata", () => {
    const installed = packs.installServicePack("slack", "slack-test", { transport: "http", url: "https://example.com/mcp", accountName: "Work" });
    assert.equal(installed.servicePackId, "slack");
    assert.equal(installed.lazy, true);
    assert.equal(config.readMcpServers()["slack-test"]?.servicePackId, "slack");
    assert.equal(config.publicMcpServerConfig(installed).url, "https://example.com/mcp");
  });

  it("rejects unknown packs and unsupported platforms", () => {
    assert.throws(() => packs.installServicePack("missing", "bad", {}), /service pack not found/);
    if (process.platform !== "darwin") {
      assert.throws(() => packs.installServicePack("imessage", "apple", { command: "node" }), /available only on darwin/);
    }
  });
});
