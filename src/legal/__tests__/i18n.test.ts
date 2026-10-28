import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Scratch layout: web/; Loam layout: packages/web/. Skip cleanly when the web tree is absent.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [path.resolve(here, "../../../web/src"), path.resolve(here, "../../../packages/web/src")];
const webSrc = candidates.find((p) => fs.existsSync(path.join(p, "components", "legal")));

test("every UI string of the legal components has an Arabic translation", { skip: !webSrc }, () => {
  const dir = path.join(webSrc ?? "", "components", "legal");
  const catalogFile = [path.join(webSrc ?? "", "i18n", "legal.i18n.json")].find((f) => fs.existsSync(f));
  const arFile = path.join(webSrc ?? "", "i18n", "ar.json");
  const catalog: Record<string, string> = catalogFile
    ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(catalogFile, "utf8")) as Record<string, { ar: string }>).map(([k, v]) => [k, v.ar]))
    : (JSON.parse(fs.readFileSync(arFile, "utf8")) as Record<string, string>);
  const keys = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // Every quoted string inside t(...) that is not the right side of a comparison.
    for (const call of src.matchAll(/\bt\(([^()]*)\)/g)) {
      for (const q of (call[1] ?? "").matchAll(/(=== )?'([^']+)'/g)) if (!q[1]) keys.add(q[2] ?? "");
    }
    for (const m of src.matchAll(/(?:label|help): '([^']+)'/g)) keys.add(m[1] ?? "");
  }
  keys.delete("");
  assert.ok(keys.size >= 60, `scanner found only ${keys.size} keys`);
  const missing = [...keys].filter((k) => !catalog[k] || !/[\u0600-\u06FF]/u.test(catalog[k] ?? ""));
  assert.deepEqual(missing, []);
});
