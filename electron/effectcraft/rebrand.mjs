#!/usr/bin/env node
/*
 * effectcraft rebrand — strips user-visible "EffectCraft"/"ArtCraft" branding
 * from the vendored web dist (electron/effectcraft/dist) and replaces it with
 * the Loam product names. Run this after every fresh copy of the dist; it is
 * idempotent.
 *
 * How it works:
 *  - index.html: text replacements of the visible app-name strings. The title
 *    becomes "Loam Effects"; a final catch-all replaces any remaining
 *    "EffectCraft" occurrence so no upstream name leaks into the UI.
 *  - *.wasm: same-length in-place byte replacement inside the data section only
 *    ("EffectCraft" -> "Loam Effect", "ArtCraft" -> "LoamFilm"). Rust string
 *    literals live in the data section with compile-time lengths, so
 *    byte-length-preserving substitution keeps the module valid. The script
 *    refuses to patch if any occurrence falls outside the data section.
 *
 * License files (LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md) are never
 * touched. Module-internal identifiers (window.effectcraft, effectcraft_*,
 * the JS glue filenames) are API surface and stay unchanged.
 *
 * The core helpers are exported so the branding rules can be unit-tested
 * against a synthetic wasm module; running this file directly performs the
 * rebrand on ./dist.
 *
 * Usage: node electron/effectcraft/rebrand.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** index.html replacements applied before the catch-all. */
export const HTML_REPLACEMENTS = [
  ['<title>EffectCraft</title>', '<title>Loam Effects</title>'],
  ['Loading EffectCraft…', 'Loading Loam Effects…'],
  ['EffectCraft stopped working', 'Loam Effects stopped working'],
  ['EffectCraft failed to start:', 'Loam Effects failed to start:'],
];

/** Final catch-all for any remaining user-visible upstream name in HTML. */
export const HTML_FALLBACK = ['EffectCraft', 'Loam Effects'];

/** Exact-length wasm pairs only: byte length must be preserved in the data section. */
export const WASM_REPLACEMENTS = [
  // 11 -> 11 bytes
  ['EffectCraft', 'Loam Effect'],
  // 8 -> 8 bytes (matches the loamfilm:// scheme name)
  ['ArtCraft', 'LoamFilm'],
];

export function uleb(buf, p) {
  let r = 0;
  let shift = 0;
  let x;
  do {
    x = buf[p++];
    r += (x & 0x7f) * 2 ** shift;
    shift += 7;
  } while (x & 0x80);
  return [r, p];
}

/** Locate the data section byte range of a valid wasm module. */
export function dataSectionRange(buf) {
  if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
    throw new Error('not a wasm module (bad magic)');
  }
  let p = 8;
  while (p < buf.length) {
    const id = buf[p++];
    const [size, np] = uleb(buf, p);
    p = np;
    if (id === 11) return [p, p + size]; // data section
    p += size;
  }
  throw new Error('wasm module has no data section');
}

export function occurrences(latin1, needle) {
  const out = [];
  let i = -1;
  while ((i = latin1.indexOf(needle, i + 1)) !== -1) out.push(i);
  return out;
}

/**
 * Replace every same-length occurrence of `from` with `to` inside the wasm data
 * section. Throws if any occurrence lies outside the data section, leaving the
 * buffer untouched.
 */
export function replaceAllBytes(buf, from, to) {
  if (from.length !== to.length) {
    throw new Error(`length mismatch: "${from}" (${from.length}) -> "${to}" (${to.length})`);
  }
  const latin1 = buf.toString('latin1');
  const [dataStart, dataEnd] = dataSectionRange(buf);
  const hits = occurrences(latin1, from);
  const outSide = hits.filter((i) => i < dataStart || i + from.length > dataEnd);
  if (outSide.length > 0) {
    throw new Error(`refusing to patch: ${from} found outside the data section (${outSide.length} hits)`);
  }
  let patched = 0;
  for (const i of hits) {
    buf.write(to, i, 'latin1');
    patched++;
  }
  return { hits: hits.length, patched };
}

/** Apply the HTML branding replacements. Returns the new markup. */
export function rebrandHtml(html) {
  let out = html;
  for (const [from, to] of HTML_REPLACEMENTS) out = out.split(from).join(to);
  const [from, to] = HTML_FALLBACK;
  out = out.split(from).join(to);
  return out;
}

/**
 * Apply the wasm branding replacements in place. Returns the number of bytes
 * patched. Throws (without writing) if a hit falls outside the data section.
 */
export function rebrandWasm(buf) {
  const before = buf.length;
  let total = 0;
  for (const [from, to] of WASM_REPLACEMENTS) {
    const { patched } = replaceAllBytes(buf, from, to);
    total += patched;
  }
  if (buf.length !== before) throw new Error('wasm size changed — aborting write');
  return total;
}

/** List the regular *.wasm files directly inside `root`. */
export function findWasmFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (extname(name).toLowerCase() !== '.wasm') continue;
    const filePath = join(root, name);
    if (statSync(filePath).isFile()) out.push(filePath);
  }
  return out;
}

/**
 * Rebrand one dist directory. Reads and validates every wasm before writing
 * anything, so a refusal (hit outside the data section) leaves the directory
 * untouched. Returns a summary of what changed.
 */
export function rebrandDist(root) {
  const summary = { changed: false, htmlChanged: false, wasmChanged: false, patched: 0, details: [] };

  const htmlPath = join(root, 'index.html');
  let htmlNext = null;
  if (existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf8');
    htmlNext = rebrandHtml(html);
    summary.htmlChanged = htmlNext !== html;
  }

  // Validate/patch all wasm buffers first; a throw here writes nothing.
  const wasmPatches = [];
  for (const wasmPath of findWasmFiles(root)) {
    const buf = readFileSync(wasmPath);
    const patched = rebrandWasm(buf);
    wasmPatches.push({ path: wasmPath, buf, patched });
  }

  if (summary.htmlChanged && htmlNext !== null) {
    writeFileSync(htmlPath, htmlNext, 'utf8');
  }
  for (const { path, buf, patched } of wasmPatches) {
    if (patched > 0) {
      writeFileSync(path, buf);
      summary.wasmChanged = true;
      summary.patched += patched;
      summary.details.push(`${path}: ${patched} hits`);
    }
  }

  summary.changed = summary.htmlChanged || summary.wasmChanged;
  return summary;
}

// --- CLI ---------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const root = join(here, 'dist');
  try {
    const summary = rebrandDist(root);
    if (!summary.changed) {
      console.log('already rebranded — nothing to do');
    } else {
      if (summary.htmlChanged) console.log('index.html: rebranded');
      for (const detail of summary.details) console.log(`${detail} -> Loam Effect / LoamFilm`);
      console.log('rebrand complete');
    }
  } catch (err) {
    console.error('rebrand failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
