#!/usr/bin/env node
/**
 * check:ui-jargon — Phase UX-W6 closing gate.
 * Scans the user-visible UI surfaces for internal jargon that must never leak
 * to users (the replacement table lives in الخدمات/UI_OVERHAUL_PROPOSAL.md §5).
 * Data-model identifiers inside JS object keys are allowed; the check targets
 * the rendered strings in the Arabic-first legacy pages and the shared HUD.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Banned user-visible jargon → the honest replacement (for the error message). */
const BANNED = [
  { pattern: /LOAM NTRIO/i, replacement: "LOAM SELF-ORGANIZING TEAM" },
  { pattern: /superstep/i, replacement: "مرحلة" },
  { pattern: /Remediation\b/, replacement: "الإصلاح المؤمَّن" },
  { pattern: /\bepisodic\b/i, replacement: "أحداث" },
  { pattern: /\bprocedural\b/i, replacement: "خطوات متعلمة" },
  { pattern: /\bsemantic\b/i, replacement: "معرفة عامة" },
];

/** Files scanned (user-visible legacy surfaces). The web stack is t()-keyed;
 *  its jargon was replaced at the call sites and is guarded by tests there. */
const SCAN_FILES = [
  "ui/index.html",
  "ui/studio-routes.js",
  "ui/app.js",
  "ui/brain.html",
  "ui/memory.html",
  "ui/memory.js",
  "ui/skills.html",
  "ui/integrations.html",
  "ui/companions.html",
];

let problems = 0;
for (const rel of SCAN_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const { pattern, replacement } of BANNED) {
    const matches = text.match(new RegExp(pattern.source, "gi"));
    if (matches) {
      problems += matches.length;
      console.error(`  jargon  ${rel}: "${matches[0]}" → استبدلها بـ "${replacement}"`);
    }
  }
}

if (problems > 0) {
  console.error(`check:ui-jargon: ${problems} problem(s)`);
  process.exit(1);
}
console.log("check:ui-jargon: PASS (لا مصطلح داخلية في الواجهة)");
