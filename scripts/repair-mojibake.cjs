#!/usr/bin/env node
'use strict';

/*
 * One-off repair for mojibake introduced by decoding UTF-8 bytes as
 * Windows-1252 and re-saving the result. Arabic and typographic characters
 * became sequences such as "ÃƒÆ’Ã‹Å“Ãƒâ€šÃ‚Â§" (Arabic) or "Ã¢â‚¬Â¦" ("…").  // encoding-check: allow
 *
 * Repair reverses that by re-encoding a string as Windows-1252 and decoding
 * the bytes as UTF-8, repeating until the text is stable. Because the
 * corruption can be several layers deep, the loop runs until the string
 * stops changing or a round would produce a replacement character.
 *
 * Usage: node scripts/repair-mojibake.cjs
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// --- Windows-1252 <-> Unicode -------------------------------------------

const CP1252_SPECIALS = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
};

const CP1252_REVERSE = new Map();
for (let byte = 0; byte <= 0xff; byte++) {
  const ch = byte <= 0x7f || byte >= 0xa0 ? String.fromCharCode(byte)
    : CP1252_SPECIALS[byte] || String.fromCharCode(byte);
  if (!CP1252_REVERSE.has(ch)) CP1252_REVERSE.set(ch, byte);
}

/** Encode a string back to Windows-1252 bytes; null when a char cannot map. */
function encodeWin1252(str) {
  const bytes = [];
  for (const ch of str) {
    const byte = CP1252_REVERSE.get(ch);
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

// Characters the clean catalogs legitimately contain. They are excluded so
// that repairing a clean value is a no-op instead of an over-iteration.
const LEGITIMATE = new Set([
  '\u00a7', // §
  '\u00e9', // é
  '\u2014', // —
  '\u2026', // …
  '\u203a', // ›
]);

const MOJIBAKE_CHARS = (() => {
  const set = new Set();
  const isLegit = (ch) =>
    LEGITIMATE.has(ch) ||
    (ch.charCodeAt(0) >= 0x0600 && ch.charCodeAt(0) <= 0x06ff) ||
    ch === '\u060c' || ch === '\u061b' || ch === '\u061f';
  for (let code = 0x0080; code <= 0x00ff; code++) {
    const ch = String.fromCharCode(code);
    if (!isLegit(ch)) set.add(ch);
  }
  for (const ch of Object.values(CP1252_SPECIALS)) {
    if (!isLegit(ch)) set.add(ch);
  }
  return set;
})();

// Residue that proves a value is still mis-decoded (Ã, Â, Ø, Ù, â€).  // encoding-check: allow
const RESIDUE = /[\u00c3\u00c2\u00d8\u00d9\u00e2\u20ac]/;

const looksMojibake = (str) => {
  for (const ch of str) {
    if (MOJIBAKE_CHARS.has(ch)) return true;
  }
  return false;
};
const isCleanArabic = (str) => /[\u0600-\u06ff]/.test(str);

function repair(str) {
  let current = str;
  for (let i = 0; i < 16; i++) {
    const bytes = encodeWin1252(current);
    if (bytes === null) return current;
    const next = bytes.toString('utf8');
    if (next === current) break;
    if (next.indexOf('\uFFFD') !== -1) break;
    current = next;
    if (!looksMojibake(current)) break;
  }
  return current;
}

// --- JSON catalogs ------------------------------------------------------

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function gitShow(rev, rel) {
  return cp.execSync(`git show ${rev}:${rel}`, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
  });
}

function loadFallback(rel, revs) {
  const map = new Map();
  for (const rev of revs) {
    let obj;
    try {
      obj = JSON.parse(gitShow(rev, rel));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!map.has(key)) map.set(key, value);
    }
  }
  return map;
}

function writeJson(rel, obj) {
  const file = path.join(ROOT, rel);
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = JSON.stringify(obj, null, 2);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text + eol, 'utf8');
}

function repairCatalog(rel, { arabic = false, fallbackRevs = [] } = {}) {
  const source = readJson(rel);
  const fallback = loadFallback(rel, fallbackRevs);
  const repaired = {};
  const collisions = [];
  const unresolved = [];
  const residue = [];

  for (const rawKey of Object.keys(source)) {
    const key = repair(rawKey);
    let value = repair(source[rawKey]);

    if (looksMojibake(value) || (arabic && !isCleanArabic(value))) {
      const candidate = fallback.get(key);
      if (candidate !== undefined) {
        const fixed = repair(candidate);
        if (!looksMojibake(fixed) && (!arabic || isCleanArabic(fixed))) {
          value = fixed;
        }
      }
    }
    if (RESIDUE.test(value)) residue.push(key);
    // An Arabic value that is not Arabic at all and has no clean source is
    // genuinely untranslated and must be handled by hand.
    if (arabic && !isCleanArabic(value) && !fallback.has(key)) unresolved.push(key);
    if (repaired[key] !== undefined && repaired[key] !== value) collisions.push(key);
    repaired[key] = value;
  }

  writeJson(rel, repaired);
  return {
    file: rel,
    keys: Object.keys(repaired).length,
    collisions,
    unresolved,
    residue,
  };
}

// --- Free-form text files ----------------------------------------------

function repairTextFile(rel) {
  const file = path.join(ROOT, rel);
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  let changed = 0;
  const residual = [];
  const out = lines.map((line, index) => {
    if (!looksMojibake(line)) return line;
    const fixed = repair(line);
    if (fixed !== line) changed += 1;
    if (RESIDUE.test(fixed)) residual.push(index + 1);
    return fixed;
  });
  fs.writeFileSync(file, out.join('\n'), 'utf8');
  return { file: rel, changed, residual };
}

// --- Main ---------------------------------------------------------------

function main() {
  const results = [
    repairCatalog('packages/web/src/i18n/en.json', {
      fallbackRevs: ['e0bdf83', '2736d9c'],
    }),
    repairCatalog('packages/web/src/i18n/ar.json', {
      arabic: true,
      fallbackRevs: ['e0bdf83', '2736d9c'],
    }),
    repairTextFile('src/server/http.ts'),
    repairTextFile('UNIMPLEMENTED_OPTIONS.md'),
  ];

  for (const r of results) {
    if (r.keys !== undefined) {
      console.log(
        `${r.file}: ${r.keys} keys` +
        (r.collisions.length ? `, ${r.collisions.length} collisions` : '') +
        (r.unresolved.length ? `, UNRESOLVED ${r.unresolved.length}` : '') +
        (r.residue.length ? `, residue ${r.residue.length}` : ''),
      );
    } else {
      console.log(
        `${r.file}: ${r.changed} lines repaired` +
        (r.residual.length ? `, residual ${r.residual.length} (${r.residual.join(',')})` : ''),
      );
    }
  }

  const failures = results.flatMap((r) => {
    const bad = r.unresolved || r.residue || [];
    return bad.map((key) => `${r.file}: ${key}`);
  });
  if (failures.length) {
    console.error('Repair left mojibake behind:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

main();
