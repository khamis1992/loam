#!/usr/bin/env node
/*
 * Rebrand a vendored OpenScreen renderer dist to Loam Recorder.
 * Licence files are left untouched. The project extension label becomes
 * .loamrec. Idempotent on an already rebranded tree.
 *
 * Usage: node electron/recorder/rebrand.mjs [distDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".md"]);
const LICENCE = /license|licence|notice|copying/i;

export const REPLACEMENTS = [
  ["OpenScreen", "Loam Recorder"],
  ["Openscreen", "Loam Recorder"],
  ["OPENSCREEN", "LOAMRECORDER"],
  [".openscreen", ".loamrec"],
  ["getopenscreen", "loam"],
  ["openscreen", "loamrecorder"],
];

export function rebrandText(text) {
  let next = text;
  for (const [from, to] of REPLACEMENTS) next = next.split(from).join(to);
  return next;
}

export function rebrandTree(distDir) {
  const changed = [];
  const leftover = [];
  const renames = [];
  if (!fs.existsSync(distDir)) return { changed, leftover };
  const stack = [distDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      const renamed = rebrandText(name);
      if (renamed !== name) renames.push(full);
      if (LICENCE.test(name) || !TEXT_EXT.has(path.extname(name))) continue;
      const before = fs.readFileSync(full, "utf8");
      const after = rebrandText(before);
      if (after !== before) {
        fs.writeFileSync(full, after);
        changed.push(full);
      }
      if (/openscreen/i.test(after)) leftover.push(full);
    }
  }
  for (const full of renames.sort((a, b) => b.length - a.length)) {
    const next = path.join(path.dirname(full), rebrandText(path.basename(full)));
    if (next !== full && fs.existsSync(full) && !fs.existsSync(next)) fs.renameSync(full, next);
  }
  return { changed, leftover };
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"));
  const { changed, leftover } = rebrandTree(distDir);
  if (leftover.length > 0) {
    console.error(`rebrand: openscreen remains in ${leftover.join(", ")}`);
    process.exit(1);
  }
  console.log(`rebrand: updated ${changed.length} file(s) in ${distDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
