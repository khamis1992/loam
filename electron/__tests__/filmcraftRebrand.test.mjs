// Unit tests for electron/filmcraft/rebrand.mjs — the post-fetch rebrand step that
// strips upstream FilmCraft/ArtCraft branding from the vendored dist and replaces
// it with "Loam Video".
//
// The module exports its core (runRebrand / replaceAllBytes / dataSectionRange) so
// these tests exercise the real code paths directly; the CLI entry point is the
// same function called with argv, so no separate runner file is needed.
//
// Covers the behaviors the vendoring script depends on:
//   - index.html visible strings are replaced
//   - wasm bytes are patched ONLY inside the data section (byte-length preserved)
//   - a hit outside the data section is refused and the file is left untouched
//   - the run is idempotent (a second run changes nothing)
//   - module-internal identifiers (window.filmcraft, *_bg.wasm) are NOT touched
//   - license/notice files are never modified
//
//   node --test electron/__tests__/filmcraftRebrand.test.mjs
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRebrand } from "../filmcraft/rebrand.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- minimal wasm helpers (mirrors the module format rebrand.mjs parses) -------
function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function section(id, body) {
  return Buffer.concat([Buffer.from([id]), uleb(body.length), body]);
}

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** A wasm whose data section holds `payload` as one active segment. */
function buildWasm(payload) {
  const segment = Buffer.concat([
    uleb(1), // one memory, min 1 page
    Buffer.from([0x00]), // active, no memory index
    Buffer.from([0x41, 0x00, 0x0b]), // i32.const 0; end
    uleb(payload.length),
    payload,
  ]);
  return Buffer.concat([MAGIC, section(11, segment)]);
}

/** A wasm with the needle in a custom section (outside the data section). */
function buildWasmWithOutsideHit() {
  const custom = section(0, Buffer.concat([uleb(15), Buffer.from([7]), Buffer.from("FilmCraft")]));
  const data = section(11, Buffer.concat([uleb(1), Buffer.from([0x00, 0x41, 0x00, 0x0b]), uleb(9), Buffer.from("FilmCraft")]));
  return Buffer.concat([MAGIC, custom, data]);
}

/** Parse the data-section byte range the way rebrand.mjs does. */
function dataRange(buf) {
  let p = 8;
  while (p < buf.length) {
    const id = buf[p++];
    let size = 0;
    let shift = 0;
    let x;
    do {
      x = buf[p++];
      size += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    if (id === 11) return [p, p + size];
    p += size;
  }
  throw new Error("no data section");
}

describe("filmcraft rebrand", () => {
  let dist;

  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "filmcraft-rebrand-"));
  });

  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  function writeHtml(body) {
    fs.writeFileSync(path.join(dist, "index.html"), body, "utf8");
  }

  function readHtml() {
    return fs.readFileSync(path.join(dist, "index.html"), "utf8");
  }

  it("replaces the visible index.html branding strings", () => {
    writeHtml(
      [
        "<html><head><title>FilmCraft</title></head><body>",
        "<p>Loading FilmCraft…</p>",
        "<div>FilmCraft stopped working</div>",
        "<span>FilmCraft failed to start: boom</span>",
        "</body></html>",
      ].join("\n"),
    );
    const result = runRebrand(dist);
    assert.equal(result.html, true);
    assert.equal(result.changed, true);
    const html = readHtml();
    assert.match(html, /<title>Loam Video<\/title>/);
    assert.match(html, /Loading Loam Video…/);
    assert.match(html, /Loam Video stopped working/);
    assert.match(html, /Loam Video failed to start: boom/);
    assert.ok(!html.includes("FilmCraft"), "no FilmCraft left in index.html");
  });

  it("patches wasm bytes only inside the data section and preserves byte length", () => {
    const wasm = buildWasm(Buffer.from("prefix FilmCraft suffix"));
    fs.writeFileSync(path.join(dist, "filmcraft_web_bg.wasm"), wasm);
    const before = fs.statSync(path.join(dist, "filmcraft_web_bg.wasm")).size;

    const result = runRebrand(dist);
    assert.equal(result.wasm, 1);

    const after = fs.readFileSync(path.join(dist, "filmcraft_web_bg.wasm"));
    assert.equal(after.length, before, "wasm byte length must not change");
    const [start, end] = dataRange(after);
    const data = after.subarray(start, end).toString("latin1");
    assert.ok(data.includes("Loam Video"), "data section must carry the new name");
    assert.ok(!data.includes("FilmCraft"), "data section must not keep the old name");
    assert.deepEqual(after.subarray(0, 8), MAGIC, "module header must be byte-identical");
  });

  it("replaces ArtCraft with LoamFilm as well", () => {
    fs.writeFileSync(path.join(dist, "filmcraft_web_bg.wasm"), buildWasm(Buffer.from("ArtCraft")));
    runRebrand(dist);
    const after = fs.readFileSync(path.join(dist, "filmcraft_web_bg.wasm"));
    const [start, end] = dataRange(after);
    const data = after.subarray(start, end).toString("latin1");
    assert.ok(data.includes("LoamFilm"));
    assert.ok(!data.includes("ArtCraft"));
  });

  it("refuses to patch when a hit falls outside the data section, leaving the file untouched", () => {
    const file = path.join(dist, "filmcraft_web_bg.wasm");
    const wasm = buildWasmWithOutsideHit();
    fs.writeFileSync(file, wasm);
    const before = fs.readFileSync(file).toString("hex");

    assert.throws(() => runRebrand(dist), /refusing to patch/, "must refuse an out-of-section hit");
    assert.equal(fs.readFileSync(file).toString("hex"), before, "wasm must be left byte-identical");
  });

  it("is idempotent: a second run changes nothing", () => {
    writeHtml("<html><title>FilmCraft</title></html>");
    fs.writeFileSync(path.join(dist, "filmcraft_web_bg.wasm"), buildWasm(Buffer.from("FilmCraft")));

    runRebrand(dist);
    const htmlAfterFirst = readHtml();
    const wasmAfterFirst = fs.readFileSync(path.join(dist, "filmcraft_web_bg.wasm")).toString("hex");

    const second = runRebrand(dist);
    assert.equal(second.changed, false, "second run must be a no-op");
    assert.equal(readHtml(), htmlAfterFirst, "html must be unchanged on the second run");
    assert.equal(fs.readFileSync(path.join(dist, "filmcraft_web_bg.wasm")).toString("hex"), wasmAfterFirst, "wasm must be unchanged on the second run");
  });

  it("leaves module-internal identifiers and license files alone", () => {
    writeHtml('<html><title>FilmCraft</title><script>window.filmcraft=1;</script></html>');
    const glue = "export const filmcraft_bridge = 1; // FilmCraft internal";
    fs.writeFileSync(path.join(dist, "filmcraft_web.js"), glue, "utf8");
    fs.writeFileSync(path.join(dist, "filmcraft_web_bg.wasm"), buildWasm(Buffer.from("FilmCraft")));
    fs.writeFileSync(path.join(dist, "LICENSE-MIT"), "FilmCraft license text", "utf8");
    fs.writeFileSync(path.join(dist, "NOTICE"), "FilmCraft notice", "utf8");
    fs.writeFileSync(path.join(dist, "ATTRIBUTION.md"), "FilmCraft attribution", "utf8");

    runRebrand(dist);

    // window.filmcraft and the AudioWorklet/bridge identifiers are API surface.
    assert.ok(readHtml().includes("window.filmcraft"), "window.filmcraft must survive");
    assert.ok(readHtml().includes("<title>Loam Video</title>"), "the visible title must be rebranded");
    assert.equal(fs.readFileSync(path.join(dist, "filmcraft_web.js"), "utf8"), glue, "JS glue file must be untouched");
    for (const f of ["LICENSE-MIT", "NOTICE", "ATTRIBUTION.md"]) {
      assert.match(fs.readFileSync(path.join(dist, f), "utf8"), /FilmCraft/, `${f} must be untouched`);
    }
  });

  it("handles a dist with no wasm or no html without throwing", () => {
    writeHtml("<html><title>FilmCraft</title></html>");
    const r = runRebrand(dist);
    assert.equal(r.html, true);
    assert.match(readHtml(), /<title>Loam Video<\/title>/);

    // An empty dist dir must be a clean no-op.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "filmcraft-rebrand-empty-"));
    try {
      const r2 = runRebrand(empty);
      assert.equal(r2.changed, false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("does not mutate the repo's real dist (sanity guard)", () => {
    const real = path.join(REPO, "electron", "filmcraft", "dist");
    const wasm = path.join(real, "filmcraft_web_bg.wasm");
    if (!fs.existsSync(wasm)) return; // dist not fetched in this checkout
    const before = fs.readFileSync(wasm);
    runRebrand(real);
    assert.deepEqual(fs.readFileSync(wasm), before, "real dist must already be rebranded and stay byte-identical");
  });
});
