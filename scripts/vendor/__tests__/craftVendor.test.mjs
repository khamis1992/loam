// Unit tests for the vendored Craft fetch/install (scripts/vendor/fetch-craft.mjs).
// No network: a tiny synthetic zip fixture is built with the shared zip helper
// (scripts/vendor/lib/zip.mjs) and the manifest sha256 is overridden for the
// happy path. The shared extractor is the same one fetch-filmcraft/fetch-effectcraft use.
//   node --test scripts/vendor/__tests__/craftVendor.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildZip, extractZip } from "../lib/zip.mjs";
import { sha256Hex } from "../lib/vendor.mjs";
import {
  CRAFT_APPS,
  CRAFT_APP_NAMES,
  craftDistDir,
  resolveZipForApp,
  runCraftFetch,
} from "../fetch-craft.mjs";

const APP = "wordcraft";
const TOP = "wordcraft-web-loam-abc123";

function craftFixture() {
  return buildZip([
    { name: `${TOP}/index.html`, data: "<!doctype html><html><body>Loam Docs</body></html>" },
    { name: `${TOP}/wordcraft_web_bg.wasm`, data: "wasm-bytes" },
    // Photo-style nested app/ parts must survive extraction.
    { name: `${TOP}/app/parts/chunk.wasm`, data: "nested" },
    // Owner decision: vendored licence/attribution files are never shipped.
    { name: `${TOP}/LICENSE-MIT`, data: "upstream licence" },
    { name: `${TOP}/README.md`, data: "upstream readme" },
  ]);
}

let tmpRoot;
let zipPath;
let zipSha;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "craft-fetch-"));
  zipPath = path.join(tmpRoot, "wordcraft-web-loam-abc123.zip");
  const buf = craftFixture();
  fs.writeFileSync(zipPath, buf);
  zipSha = sha256Hex(buf);
});

after(() => {
  delete process.env.LOAM_CRAFT_WORDCRAFT_ZIP;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("fetch-craft", () => {
  it("exposes the five apps and user-facing names", () => {
    assert.deepEqual(CRAFT_APPS, ["wordcraft", "gridcraft", "deckcraft", "photocraft", "designcraft"]);
    assert.equal(CRAFT_APP_NAMES[APP], "Loam Docs");
    for (const app of CRAFT_APPS) {
      assert.ok(CRAFT_APP_NAMES[app].startsWith("Loam "), `${app} name must be Loam-branded`);
    }
  });

  it("uses the LOAM_CRAFT_<APP>_ZIP env path first", () => {
    const found = resolveZipForApp(APP, { env: { LOAM_CRAFT_WORDCRAFT_ZIP: zipPath }, cacheDir: tmpRoot });
    assert.equal(found.source, "env");
    assert.equal(found.zipPath, path.resolve(zipPath));
  });

  it("aborts a sha mismatch and does not install", () => {
    const distDir = path.join(tmpRoot, "bad-dist");
    return assert.rejects(
      () => runCraftFetch(APP, { distDir, sha256: "00".repeat(32), env: { LOAM_CRAFT_WORDCRAFT_ZIP: zipPath } }),
      /sha256 mismatch/,
    ).then(() => {
      assert.equal(fs.existsSync(path.join(distDir, ".vendor.json")), false);
    });
  });

  it("skips when the dist is already present", () => {
    const distDir = craftDistDir(APP, tmpRoot);
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>");
    return runCraftFetch(APP, { distDir }).then((result) => {
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "already-present");
    });
  });

  it("installs the env zip, writes .vendor.json and preserves nested app/ folders", () => {
    const distDir = craftDistDir(APP, tmpRoot);
    return runCraftFetch(APP, {
      distDir,
      force: true,
      sha256: zipSha,
      env: { LOAM_CRAFT_WORDCRAFT_ZIP: zipPath },
    }).then((result) => {
      assert.equal(result.skipped, false);
      assert.equal(result.source, "env");
      assert.equal(result.sha256, zipSha);

      assert.equal(
        fs.readFileSync(path.join(distDir, "index.html"), "utf8"),
        "<!doctype html><html><body>Loam Docs</body></html>",
      );
      // Photo-style nested app/ parts must be preserved.
      assert.equal(fs.readFileSync(path.join(distDir, "app", "parts", "chunk.wasm"), "utf8"), "nested");
      // Vendored licence/readme files are pruned.
      assert.equal(fs.existsSync(path.join(distDir, "LICENSE-MIT")), false);
      assert.equal(fs.existsSync(path.join(distDir, "README.md")), false);

      const meta = JSON.parse(fs.readFileSync(path.join(distDir, ".vendor.json"), "utf8"));
      assert.equal(meta.app, APP);
      assert.equal(meta.sha256, zipSha);
      assert.equal(meta.source, "env");
      assert.ok(meta.rev, "rev from the manifest is recorded");
      assert.ok(!Number.isNaN(Date.parse(meta.fetchedAt)), "fetchedAt is an ISO timestamp");
    });
  });

  it("reports unavailable with fetch instructions when no source exists", () => {
    const distDir = path.join(tmpRoot, "missing-dist");
    return runCraftFetch(APP, {
      distDir,
      env: {},
      cacheDir: path.join(tmpRoot, "empty-cache"),
    }).then((result) => {
      assert.equal(result.skipped, true);
      assert.match(result.reason, /fetch-craft\.mjs/);
      assert.match(result.reason, /LOAM_CRAFT_WORDCRAFT_ZIP/);
      assert.equal(fs.existsSync(path.join(distDir, ".vendor.json")), false);
    });
  });

  it("rejects path traversal in the shared zip extractor", () => {
    const buf = buildZip([{ name: "../evil.txt", data: "x" }]);
    assert.throws(() => extractZip(buf, path.join(tmpRoot, "zip-evil")), /unsafe entry name/);
  });
});
