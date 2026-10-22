#!/usr/bin/env node
/*
 * filmcraft rebrand — strips user-visible "FilmCraft"/"ArtCraft" branding from
 * the vendored web dist (electron/filmcraft/dist) and replaces it with
 * "Loam Video". Run this after every fresh copy of the dist; it is idempotent.
 *
 * How it works:
 *  - index.html: plain text replacements of the visible app-name strings.
 *  - filmcraft_web_bg.wasm: same-length in-place byte replacement inside the
 *    data section only ("FilmCraft" -> "Loam Video", "ArtCraft" -> "LoamFilm").
 *    Rust string literals live in the data section with compile-time lengths,
 *    so byte-length-preserving substitution keeps the module valid. The script
 *    refuses to patch if any occurrence falls outside the data section.
 *
 * License files (LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md) are never
 * touched. Module-internal identifiers (window.filmcraft, filmcraft_*, the JS
 * glue filenames, the AudioWorklet processor name) are API surface and stay
 * unchanged.
 *
 * Usage: node electron/filmcraft/rebrand.mjs [distDir]
 * The optional distDir argument defaults to ./dist next to this script; the
 * vendoring scripts (scripts/vendor/fetch-filmcraft.mjs) pass their target so a
 * freshly extracted dist is rebranded in place.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? isAbsolute(process.argv[2])
    ? process.argv[2]
    : resolve(process.cwd(), process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), 'dist');
const WASM = join(root, 'filmcraft_web_bg.wasm');
const HTML = join(root, 'index.html');

const HTML_REPLACEMENTS = [
  ['<title>FilmCraft</title>', '<title>Loam Video</title>'],
  ['Loading FilmCraft…', 'Loading Loam Video…'],
  ['FilmCraft stopped working', 'Loam Video stopped working'],
  ['FilmCraft failed to start:', 'Loam Video failed to start:'],
];

const WASM_REPLACEMENTS = [
  // Exact-length pairs only: byte length must be preserved in the data section.
  ['FilmCraft', 'Loam Video'],
  ['ArtCraft', 'LoamFilm'],
];

function uleb(buf, p) {
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
function dataSectionRange(buf) {
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

function occurrences(latin1, needle) {
  const out = [];
  let i = -1;
  while ((i = latin1.indexOf(needle, i + 1)) !== -1) out.push(i);
  return out;
}

function replaceAllBytes(buf, from, to) {
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

let changed = false;

// --- index.html -------------------------------------------------------------
if (existsSync(HTML)) {
  let html = readFileSync(HTML, 'utf8');
  for (const [from, to] of HTML_REPLACEMENTS) {
    if (html.includes(from)) {
      html = html.replaceAll(from, to);
      console.log(`index.html: "${from}" -> "${to}"`);
      changed = true;
    }
  }
  if (changed) writeFileSync(HTML, html, 'utf8');
}

// --- filmcraft_web_bg.wasm --------------------------------------------------
if (existsSync(WASM)) {
  const buf = readFileSync(WASM);
  const before = buf.length;
  let total = 0;
  for (const [from, to] of WASM_REPLACEMENTS) {
    const { patched } = replaceAllBytes(buf, from, to);
    if (patched > 0) {
      console.log(`filmcraft_web_bg.wasm: ${from} -> ${to} (${patched} hits)`);
      total += patched;
      changed = true;
    }
  }
  if (total > 0) {
    if (buf.length !== before) throw new Error('wasm size changed — aborting write');
    writeFileSync(WASM, buf);
  }
}

if (!changed) console.log('already rebranded — nothing to do');
else console.log('rebrand complete');