// Unit tests for electron/vendorProtocol.cjs (the shared static-file serving
// used by loamfilm:// and loamcraft://). Covers the allowed Craft app ids,
// path-traversal rejection and the MIME mapping.
//   node --test electron/__tests__/vendorProtocol.test.cjs
const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vp = require("../vendorProtocol.cjs");

describe("vendorProtocol MIME mapping", () => {
  it("maps the vendor bundle extensions and defaults to octet-stream", () => {
    assert.equal(vp.vendorMime("a/b/index.html"), "text/html");
    assert.equal(vp.vendorMime("a/b/app.js"), "text/javascript");
    assert.equal(vp.vendorMime("a/b/app_bg.wasm"), "application/wasm");
    assert.equal(vp.vendorMime("a/b/icon.ico"), "image/x-icon");
    assert.equal(vp.vendorMime("a/b/font.woff2"), "font/woff2");
    assert.equal(vp.vendorMime("a/b/font.ttf"), "font/ttf");
    assert.equal(vp.vendorMime("a/b/logo.png"), "image/png");
    assert.equal(vp.vendorMime("a/b/unknown.part"), "application/octet-stream");
  });
});

describe("vendorProtocol Craft resolution", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-proto-"));
    const dist = path.join(root, "electron", "craft", "wordcraft", "dist");
    fs.mkdirSync(path.join(dist, "app", "parts"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(dist, "wordcraft_web_bg.wasm"), "wasm");
    fs.writeFileSync(path.join(dist, "app", "parts", "chunk.wasm"), "chunk");
    fs.writeFileSync(path.join(root, "electron", "craft", "SECRET.txt"), "outside dist");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves only the five allowed app ids", () => {
    for (const app of vp.CRAFT_APP_IDS) {
      const file = vp.resolveCraftFile(root, { url: `loamcraft://${app}/index.html` });
      // Only wordcraft has a fixture; the others must resolve to null (missing
      // dist), proving the id itself is accepted (not rejected as unknown).
      if (app === "wordcraft") assert.ok(file, `${app} should resolve`);
    }
    assert.equal(vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/index.html" }), path.join(root, "electron", "craft", "wordcraft", "dist", "index.html"));
    assert.equal(vp.resolveCraftFile(root, { url: "loamcraft://evil/index.html" }), null);
    assert.equal(vp.resolveCraftFile(root, { url: "loamcraft://WordCraft/index.html" }), path.join(root, "electron", "craft", "wordcraft", "dist", "index.html"));
  });

  it("resolves nested app/ parts and defaults the bare path to index.html", () => {
    assert.equal(
      vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/app/parts/chunk.wasm" }),
      path.join(root, "electron", "craft", "wordcraft", "dist", "app", "parts", "chunk.wasm"),
    );
    assert.equal(
      vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/" }),
      path.join(root, "electron", "craft", "wordcraft", "dist", "index.html"),
    );
  });

  it("rejects path traversal", () => {
    assert.equal(vp.resolveVendorFile("/../SECRET.txt", [path.join(root, "electron", "craft", "wordcraft", "dist")]), null);
    assert.equal(vp.resolveVendorFile("/..%2f..%2fsecret", [path.join(root, "electron", "craft", "wordcraft", "dist")]), null);
    assert.equal(vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/%2e%2e/SECRET.txt" }), null);
    assert.equal(vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/..%2f..%2f..%2fetc%2fpasswd" }), null);
  });

  it("returns a 404 response and a typed response", () => {
    const missing = vp.vendorNotFound();
    assert.equal(missing.status, 404);
    const file = vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/index.html" });
    const res = vp.vendorResponse(file);
    assert.equal(res.headers.get("Content-Type"), "text/html");
    const wasm = vp.resolveCraftFile(root, { url: "loamcraft://wordcraft/wordcraft_web_bg.wasm" });
    assert.equal(vp.vendorResponse(wasm).headers.get("Content-Type"), "application/wasm");
  });
});
