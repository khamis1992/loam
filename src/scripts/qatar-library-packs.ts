/**
 * Build research_snapshot LegalPacks from the core laws in a Qatar law
 * library copy. Read-only on the library; writes JSON packs + REPORT.md.
 *   tsx src/scripts/qatar-library-packs.ts <libraryDir> <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import { validatePack } from "../legal/corpusStore.js";
import { libraryMarkdownToPack } from "../legal/libraryPacks.js";

const [lib, outDir] = process.argv.slice(2);
if (!lib || !outDir) { console.error("usage: qatar-library-packs <libraryDir> <outDir>"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const files = fs.readdirSync(lib).filter((f) => /^\d{2}_.+\.md$/.test(f)).sort();
const report: string[] = [`# Core law packs (${today}) — provenance research_snapshot, verifiedBy EMPTY`, "", "| file | key | articles | amended (review) | repealed (skipped) | status |", "|---|---|---|---|---|---|"];
let bad = 0;
for (const f of files) {
  const r = libraryMarkdownToPack(f, fs.readFileSync(path.join(lib, f), "utf8"), today);
  if (!r.pack) { report.push(`| ${f} | — | 0 | — | — | SKIPPED: ${r.warnings.join("; ")} |`); continue; }
  const errs = validatePack(r.pack);
  if (errs.length) bad++;
  const key = `${r.pack.legislation.type}/${r.pack.legislation.year}/${r.pack.legislation.number}`;
  fs.writeFileSync(path.join(outDir, f.replace(/\.md$/, ".pack.json")), JSON.stringify(r.pack, null, 1));
  report.push(`| ${f} | ${key} | ${r.pack.articles.length} | ${r.amended.length} | ${r.skipped.length} | ${errs.length ? `INVALID: ${errs.join("; ")}` : "valid"}${r.warnings.length ? ` (${r.warnings.length} warnings)` : ""} |`);
}
report.push("", "Every pack is a DRAFT: tags are inferred from Al Meezan; a named person must verify against the Official Gazette before upgrading provenance.");
fs.writeFileSync(path.join(outDir, "REPORT.md"), report.join("\n") + "\n");
console.log(report.join("\n"));
process.exit(bad ? 1 : 0);
