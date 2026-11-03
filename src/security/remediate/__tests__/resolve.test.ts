import assert from "node:assert/strict";
import test from "node:test";
import { resolveTarget, fetchRegistryManifest, nodeDistExtract } from "../resolve/targetResolver.js";
import { loadPack } from "../packs/loader.js";
import { FIXTURES, materialize, readFixtureFiles } from "./fixtures.js";
import { runInventory } from "../inventory/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const advisories = path.resolve(process.cwd(), "security", "advisories");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("registry manifest: 200 + digest -> verified; 404 -> not_found; network error -> unverified", async () => {
  const ok = await fetchRegistryManifest("node:22.23.4-alpine", async () => jsonResponse("{}", 200));
  assert.equal(ok.status, "verified");
  assert.ok(ok.evidence?.digest?.startsWith("sha256:"));

  const nf = await fetchRegistryManifest("node:99.99.99", async () => jsonResponse("{}", 404));
  assert.equal(nf.status, "not_found");

  const err = await fetchRegistryManifest("node:22.23.4", async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(err.status, "unverified");
  assert.match(err.reason ?? "", /ECONNREFUSED/);
});

test("resolver: pack membership + vendor index -> verified with evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-res-"));
  try {
    const { pack, sha256 } = loadPack("node-2026-10-21", advisories);
    const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, tmp);
    const result = runInventory([{ repoId: "nva", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
    const row = result.records.find((r) => r.hit.file === "Dockerfile")!;
    assert.equal(row.proposedTarget, "22.23.4");

    const verification = await resolveTarget(row, pack, sha256, {
      fetcher: async () => jsonResponse([{ version: "v22.23.4" }, { version: "v22.21.0" }]),
    });
    assert.equal(verification.status, "verified");
    assert.equal(verification.target.value, "22.23.4");
    assert.equal(verification.evidence.length, 1);
    assert.equal(verification.evidence[0]!.kind, "vendor_release_index");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolver: version missing from the index -> not_found; fetch throws -> unverified with reason", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-res2-"));
  try {
    const { pack, sha256 } = loadPack("node-2026-10-21", advisories);
    const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, tmp);
    const result = runInventory([{ repoId: "nva", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
    const row = result.records.find((r) => r.hit.file === "Dockerfile")!;

    const missing = await resolveTarget(row, pack, sha256, { fetcher: async () => jsonResponse([{ version: "v22.21.0" }]) });
    assert.equal(missing.status, "not_found");

    const broken = await resolveTarget(row, pack, sha256, { fetcher: async () => { throw new Error("offline"); } });
    assert.equal(broken.status, "unverified");
    assert.match(broken.reason ?? "", /offline/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolver: electron tracker refuses any proposal without verified releases (D-7)", async () => {
  const { pack, sha256 } = loadPack("electron-bundled-node", advisories);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-res3-"));
  try {
    const efx = FIXTURES.find((f) => f.name === "electron-app")!;
    const dir = materialize(efx, tmp);
    const result = runInventory([{ repoId: "ea", files: readFixtureFiles(dir), lockfileContent: efx.files["package-lock.json"]! }], advisories);
    const row = result.records.find((r) => r.hit.channel === "electron")!;
    const verification = await resolveTarget(row, pack, sha256, { fetcher: async () => jsonResponse([]) });
    assert.equal(verification.status, "unverified");
    assert.match(verification.reason ?? "", /no verified Electron release/);
    assert.equal(verification.target.value, "none");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolver: EOL row -> not_found with the upgrade-path reason", async () => {
  const { pack, sha256 } = loadPack("node-2026-10-21", advisories);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-res4-"));
  try {
    const dir = materialize(FIXTURES.find((f) => f.name === "node-eol-app")!, tmp);
    const result = runInventory([{ repoId: "eol", files: readFixtureFiles(dir), lockfileContent: null }], advisories);
    const row = result.records[0]!;
    assert.equal(row.status, "eol");
    const verification = await resolveTarget(row, pack, sha256, { fetcher: async () => jsonResponse([]) });
    assert.equal(verification.status, "not_found");
    assert.match(verification.reason ?? "", /EOL/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("nodeDistExtract matches the real index.json shape", () => {
  const body = '[{"version":"v22.23.4","date":"2026-10-21"},{"version":"v22.21.0"}]';
  assert.equal(nodeDistExtract("22.23.4")(body), "22.23.4");
  assert.equal(nodeDistExtract("99.99.99")(body), null);
});
