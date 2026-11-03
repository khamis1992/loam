#!/usr/bin/env node
/**
 * check:release-safety — Phase UX closing gate (the systemic fix).
 *
 * ROOT CAUSE THIS GUARDS AGAINST: security/UX fixes applied in one worktree
 * were silently lost when a release was built from a branch that forked
 * before the fix landed (the "Failed to fetch" regression shipped in 0.5.35
 * build #1 this way — twice-fixed, twice-lost).
 *
 * This gate asserts the load-bearing fixes are present in the SOURCE TREE
 * before any release build. It runs against the working tree, so it fails
 * fast on a stale branch — before an installer ever ships.
 *
 * Wire into the release flow: run before `npm run dist` (or add to verify).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Load-bearing fixes that must never regress. Each check is a file → list of
 *  required substrings (from the actual fix commits). */
const REQUIRED_FIXES = [
  {
    name: "CORS :3939 (global app://agent block — ALL API routes, not just /api/legal)",
    file: "src/server/http.ts",
    fixCommit: "4cb0d14",
    // ALLOWED_ORIGINS is unique to the global block; the legal-only OPTIONS
    // handler predates it and must not satisfy this check.
    required: ["const ALLOWED_ORIGINS = new Set([\"app://agent\"", "access-control-allow-headers", "x-loam-local-token"],
  },
  {
    name: "CORS :8787 (x-loam-local-token in the protocol adapter Allow-Headers)",
    file: "src/protocol/adapter.ts",
    fixCommit: "0505249 / 4769ccc",
    required: ['"authorization, content-type, connect-protocol-version, x-client-id, x-client-type, x-client-version, x-client-locale, x-client-timezone, x-client-timezone-offset, x-loam-local-token"'],
  },
  {
    name: "Intent router mounted (one-box auto mode)",
    file: "src/server/intentRouter.ts",
    fixCommit: "bc94be0 / 1d8b090",
    required: ["routeIntent", "classifyIntentByKeywords"],
  },
];

let problems = 0;
for (const fix of REQUIRED_FIXES) {
  const file = path.join(ROOT, fix.file);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    console.error(`  missing  ${fix.file} — الملف المطلوب للإصلاح غير موجود`);
    problems++;
    continue;
  }
  for (const needle of fix.required) {
    if (!text.includes(needle)) {
      console.error(`  regressed  [${fix.name}] "${needle}" غير موجود في ${fix.file} (أصل الإصلاح: ${fix.fixCommit})`);
      problems++;
    }
  }
}

if (problems > 0) {
  console.error(`check:release-safety: FAIL — ${problems} إصلاحًا أساسيًا مفقودًا من الشجرة. لا تبني نسخة إصدار من هذا الفرع.`);
  process.exit(1);
}
console.log(`check:release-safety: PASS — ${REQUIRED_FIXES.length} إصلاحًا أساسيًا موجودًا في الشجرة`);
