#!/usr/bin/env node
/**
 * check:ui-numbers — consistency check between the real LOAM_MODES catalog
 * (src/modes/catalog.ts) and hardcoded "N Modes" / "N أنماط" counts in the
 * legacy ui/ shell (ui/index.html, ui/studio-routes.js).
 *
 * Dependency-free: node:fs + regex only. Exit 0 = PASS, 1 = FAIL.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const normalizeDigits = (s) => s.replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]);

// ---- (a) real LOAM_MODES entry count from src/modes/catalog.ts ----------
const catalogPath = path.join(root, 'src', 'modes', 'catalog.ts');
let catalog;
try {
  catalog = readFileSync(catalogPath, 'utf8');
} catch (err) {
  console.error(`check:ui-numbers: cannot read ${path.relative(root, catalogPath)} — ${err.message}`);
  process.exit(2);
}

const spanStart = catalog.indexOf('export const LOAM_MODES');
if (spanStart < 0) {
  console.error('check:ui-numbers: cannot find "export const LOAM_MODES" in src/modes/catalog.ts');
  process.exit(2);
}
const spanEnd = catalog.indexOf('\n];', spanStart);
if (spanEnd < 0) {
  console.error('check:ui-numbers: cannot find the end of the LOAM_MODES array in src/modes/catalog.ts');
  process.exit(2);
}
const span = catalog.slice(spanStart, spanEnd);

// Count top-level entries inside the LOAM_MODES array with a string- and
// depth-aware scanner (entries may be object literals or bare imported
// entries like `reverseEngineerMode`, and may share a line).
function countTopLevelEntries(text) {
  // Anchor on the array literal ("= ["), not the `LoamMode[]` type annotation.
  const arrStart = text.indexOf('= [');
  if (arrStart < 0) return -1;
  let bracketDepth = 0; // [ ] nesting (the array itself is depth 1)
  let braceDepth = 0;   // { } nesting inside it
  let inStr = null;     // '"' | "'" | '`'
  let esc = false;
  let entries = 0;
  let atEntryStart = false;
  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (ch === '[') { bracketDepth++; continue; }
    if (ch === ']') { bracketDepth--; if (bracketDepth === 0) break; continue; }
    if (ch === '{') { braceDepth++; if (bracketDepth === 1 && braceDepth === 1) entries++; continue; }
    if (ch === '}') { braceDepth--; continue; }
    if (bracketDepth === 1 && braceDepth === 0) {
      if (/[A-Za-z_$]/.test(ch)) {
        // Bare imported entry (e.g. `reverseEngineerMode`) — count once.
        if (!atEntryStart) { entries++; atEntryStart = true; }
        continue;
      }
      if (ch === ',') { atEntryStart = false; continue; }
    }
  }
  return entries;
}

const realCount = countTopLevelEntries(span);
if (realCount < 0) {
  console.error('check:ui-numbers: cannot parse the LOAM_MODES array in src/modes/catalog.ts');
  process.exit(2);
}

// ---- (b) hardcoded counts in the legacy ui shell ------------------------
const UI_FILES = ['ui/index.html', 'ui/studio-routes.js'];
const COUNT_RE = /(\d+)\s*(?:Modes|أنماط)/g;

const findings = [];
for (const rel of UI_FILES) {
  const abs = path.join(root, ...rel.split('/'));
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    findings.push({ rel, line: 0, raw: '<missing file>', n: null });
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    // Strip markup so patterns like "<b>7</b> Modes" are caught too.
    const plain = normalizeDigits(lineText.replace(/<[^>]+>/g, ' '));
    for (const m of plain.matchAll(COUNT_RE)) {
      findings.push({ rel, line: i + 1, raw: m[0].replace(/\s+/g, ' ').trim(), n: Number(m[1]) });
    }
  });
}

// ---- (c) verdict ---------------------------------------------------------
console.log(`check:ui-numbers — real LOAM_MODES count: ${realCount} [src/modes/catalog.ts]`);

let ok = true;
if (findings.length === 0) {
  console.log('  ui/index.html, ui/studio-routes.js: no hardcoded "N Modes"/"N أنماط" counts found — nothing to verify.');
} else {
  for (const rel of UI_FILES) {
    const rows = findings.filter((f) => f.rel === rel);
    if (rows.length === 0) {
      console.log(`  scan  ${rel}: no hardcoded "N Modes"/"N أنماط" counts — nothing to verify.`);
      continue;
    }
    for (const f of rows) {
      if (f.n === realCount) {
        console.log(`  PASS  ${f.rel}:${f.line} "${f.raw}" == ${realCount}`);
      } else {
        ok = false;
        console.log(`  FAIL  ${f.rel}:${f.line} "${f.raw}" != ${realCount}`);
      }
    }
  }
}

console.log(ok ? 'check:ui-numbers: PASS' : 'check:ui-numbers: FAIL');
process.exit(ok ? 0 : 1);
