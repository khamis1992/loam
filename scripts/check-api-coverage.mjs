#!/usr/bin/env node
/**
 * check:api-coverage — Phase UX closing gate (the systemic audit).
 *
 * ROOT CAUSE CLASS THIS GUARDS: a web page ships calling an /api endpoint whose
 * server handler was never mounted (the Board page shipped this way — UI ready,
 * /api/board/* handlers existed but were never wired into http.ts → 404).
 *
 * Method: extract every distinct /api/<a>/<b> prefix called from the web stack
 * (packages/web/src), then verify each first segment pair appears somewhere in
 * the server sources (src/server + src/protocol + src/llm). This is a coverage
 * heuristic, not a contract test — it catches the "page exists, backend never
 * mounted" class, which is exactly the regression class the user kept hitting.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB_SRC = path.join(ROOT, "packages", "web", "src");
const SERVER_DIRS = [
  path.join(ROOT, "src", "server"),
  path.join(ROOT, "src", "protocol"),
  path.join(ROOT, "src", "llm"),
  path.join(ROOT, "src", "appbuilder"),
  path.join(ROOT, "src", "office"),
];

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Collect distinct /api/<seg1>/<seg2> prefixes from string literals. */
function collectApiPrefixes(files) {
  const prefixes = new Map(); // prefix → first file that called it
  const re = /["'`](\/api\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)?)/gi;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(re)) {
      const prefix = match[1];
      if (!prefixes.has(prefix)) prefixes.set(prefix, path.relative(ROOT, file));
    }
  }
  return prefixes;
}

const webFiles = walk(WEB_SRC, [".ts", ".tsx"]).filter((f) => !f.includes("__tests__"));
const called = collectApiPrefixes(webFiles);

const serverFiles = SERVER_DIRS.flatMap((dir) => walk(dir, [".ts"])).filter((f) => !f.includes("__tests__"));
const serverText = serverFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const serverFilesByPath = new Map(serverFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));

/** A called prefix is covered when its first two segments appear in ANY server
 *  source (mounted handler, startsWith guard, or literal route). */
function isCovered(prefix) {
  const segments = prefix.split("/").filter(Boolean); // ["api", "board"]
  const twoSeg = "/" + segments.slice(0, 2).join("/");
  return serverText.includes(twoSeg);
}

let missing = 0;
console.log(`تدقيق تغطية الـAPI: ${called.size} بادئة تُستدعى من الواجهة\n`);
for (const [prefix, caller] of [...called.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!isCovered(prefix)) {
    missing++;
    console.error(`  uncovered  ${prefix}  (تُستدعى من: ${caller})`);
  }
}

if (missing > 0) {
  console.error(`check:api-coverage: FAIL — ${missing} بادئة /api تُستدعى من الواجهة بلا خادم يغطيها`);
  process.exit(1);
}
console.log(`check:api-coverage: PASS — كل بادئات /api المستدعاة من الواجهة مغطاة في الخادم`);
