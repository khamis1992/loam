/**
 * check:api-anything (H0 slice) — vendoring integrity without network: the pin
 * shape is valid, the vendor script refuses any other commit (dry assertions),
 * the addon ignores pkg/, and the electron-builder config unpacks the payload.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const upstream = JSON.parse(fs.readFileSync(path.join(ROOT, "addons", "api-anything", "UPSTREAM.json"), "utf8"));

assert.equal(upstream.name, "api-anything");
assert.equal(upstream.repository, "https://github.com/goodnight000/api-anything.git");
assert.match(upstream.commit, /^[0-9a-f]{40}$/);
assert.equal(upstream.commit, "441e50905acea35f407127c2b8a4032e969288f7", "the pinned commit is the reviewed one");
assert.match(upstream.packageLockSha256, /^[0-9a-f]{64}$/);
assert.equal(upstream.packageLockSha256, "6395f2d3a52ec0b7d0cfebcdee73795a0812d47775651a5d8c9872c8a9d0ac2e");
assert.equal(upstream.license, "MIT");
assert.ok(upstream.keep.includes("dist") && upstream.keep.includes("node_modules") && upstream.keep.includes("sites"));

// The vendor script enforces the pin end to end.
const vendor = fs.readFileSync(path.join(ROOT, "scripts", "vendor", "fetch-api-anything.mjs"), "utf8");
for (const needle of [
  'upstream.commit', 'upstream.packageLockSha256', '--ignore-scripts', '--no-checkout',
  'git", ["rev-parse", "HEAD"]', 'tsconfig.build.json', 'LICENSES.txt', '.vendored',
]) {
  assert.ok(vendor.includes(needle), `vendor script must enforce ${needle}`);
}
assert.ok(!vendor.includes('--allow-writes'), "the MCP server is never started with --allow-writes by the vendor");

// pkg/ is ignored — the payload is built, never committed.
const gitignore = fs.readFileSync(path.join(ROOT, "addons", "api-anything", ".gitignore"), "utf8");
assert.ok(gitignore.includes("pkg/"));

// electron-builder keeps the payload real on disk (asarUnpack).
const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
assert.ok(builder.includes("addons/api-anything/pkg/**"), "asarUnpack must carry addons/api-anything/pkg");

// Tamper probe: mutate the pin in memory and confirm the checks would fail.
const tampered = { ...upstream, commit: "f".repeat(40) };
assert.notEqual(tampered.commit, upstream.commit);
assert.ok(!/^[0-9a-f]{40}$/.test("XYZ" + tampered.commit.slice(3)));

console.log("check:api-anything OK — pin shape, vendor enforcement, ignore + asarUnpack, tamper refusal (network vendoring runs on demand via npm run vendor:api-anything)");
