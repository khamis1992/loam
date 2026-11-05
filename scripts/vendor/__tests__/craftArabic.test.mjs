import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const root = path.resolve(here, "../../..");
const patch = fs.readFileSync(path.join(root, "scripts/vendor/craft/apply_patch.py"), "utf8");
const build = fs.readFileSync(path.join(root, "scripts/vendor/craft/build-craft-web.sh"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/vendor/craft/manifest.json"), "utf8"));

test("deckcraft web builds require Arabic glyph coverage and its licence", () => {
  assert.match(patch, /\("Noto Sans Arabic", "Regular"\)/);
  assert.match(patch, /loam_arabic_face_is_required_for_web_documents/);
  assert.match(patch, /glyphs\.iter\(\)\.all\(\|g\| g\.gid != 0\)/);
  assert.match(build, /CRAFT_FONTS_REQUIRED=1/);
  assert.match(build, /noto-sans-arabic\/OFL\.txt/);
  assert.equal(manifest.fonts.rev, "aced4137c022f1f587624d48e81ec77e1914a9cc");
});
