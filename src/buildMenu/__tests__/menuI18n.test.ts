/**
 * Build-menu strings used by BuildMenuEntry and BuildLauncher.
 * Each t() key needs a non-empty Arabic and English catalog value.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit src/buildMenu/__tests__/menuI18n.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

function quotedCalls(src: string, fn: string): string[] {
  const keys: string[] = [];
  const patterns = [
    new RegExp(`\\b${fn}\\(\\s*'((?:\\\\'|[^'])*)'`, "g"),
    new RegExp(`\\b${fn}\\(\\s*"((?:\\\\"|[^"])*)"`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      keys.push((match[1] ?? "").replace(/\\'/g, "'").replace(/\\"/g, '"'));
    }
  }
  return keys;
}

function publishHandoffKeys(src: string): string[] {
  const block = src.match(/function publishHandoff[\s\S]*?\n\}/);
  if (!block) return [];
  const keys: string[] = [];
  for (const match of block[0].matchAll(/return\s+'([^']+)'/g)) keys.push(match[1] ?? "");
  for (const match of block[0].matchAll(/return\s+"([^"]+)"/g)) keys.push(match[1] ?? "");
  return keys;
}

function buildMenuKeys(): string[] {
  const files = [
    path.join(root, "packages/web/src/components/build/BuildMenuEntry.tsx"),
    path.join(root, "packages/web/src/components/build/BuildLauncher.tsx"),
  ];
  const keys = new Set<string>();
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const key of quotedCalls(src, "t")) keys.add(key);
    for (const key of publishHandoffKeys(src)) keys.add(key);
  }
  keys.delete("");
  return [...keys];
}

test("every build-menu t() key has a non-empty ar and en string without Sparkles", () => {
  const ar = JSON.parse(fs.readFileSync(path.join(root, "packages/shared/src/i18n/ar.json"), "utf8")) as Record<string, string>;
  const en = JSON.parse(fs.readFileSync(path.join(root, "packages/shared/src/i18n/en.json"), "utf8")) as Record<string, string>;
  const keys = buildMenuKeys();
  assert.ok(keys.length >= 60, `scanner found only ${keys.length} keys`);
  const problems: string[] = [];
  for (const key of keys) {
    const arValue = ar[key];
    const enValue = en[key];
    if (typeof arValue !== "string" || arValue.trim().length === 0) problems.push(`ar empty: ${key}`);
    if (typeof enValue !== "string" || enValue.trim().length === 0) problems.push(`en empty: ${key}`);
    if (typeof arValue === "string" && arValue.includes("Sparkles")) problems.push(`ar Sparkles: ${key}`);
    if (typeof enValue === "string" && enValue.includes("Sparkles")) problems.push(`en Sparkles: ${key}`);
  }
  assert.deepEqual(problems, []);
});
