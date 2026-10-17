import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";

export type IssueKind = "bom" | "mojibake" | "invalid-utf8" | "invalid-json";

export interface EncodingIssue {
  file: string;
  kind: IssueKind;
  detail: string;
}

const SCAN_DIRS = ["ui", "electron", "skills", "src", "scripts"];
const SCAN_ROOT_FILES = ["README.md", "config.json", "package.json", "tsconfig.json"];
const TEXT_EXT = new Set([".ts", ".js", ".cjs", ".mjs", ".html", ".css", ".json", ".md", ".bat", ".ps1", ".py", ".txt"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "data", "workspace", ".git"]);

/** cp1252 misreading of UTF-8 Arabic/CJK leaves lead bytes as "Ø/Ù/Â/Ã/â" followed by a
 *  continuation byte rendered as a cp1252 glyph. This is the classic Windows PowerShell bug. */
const MOJIBAKE_RE = /[\u00C2\u00C3\u00D8\u00D9\u00E2][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g;

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(path.join(dir, entry.name));
  }
}

function checkFile(file: string): EncodingIssue[] {
  const issues: EncodingIssue[] = [];
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    issues.push({ file, kind: "invalid-utf8", detail: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
    return issues;
  }
  const rel = path.relative(ROOT, file).split(path.sep).join("/");

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    issues.push({ file: rel, kind: "bom", detail: "UTF-8 BOM present (stripped by tools, breaks some loaders)" });
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    issues.push({ file: rel, kind: "invalid-utf8", detail: "not valid UTF-8" });
    return issues;
  }

  // Lines explicitly documenting this failure mode may opt out with a marker.
  const scannable = text
    .split(/\r?\n/)
    .filter((line) => !line.includes("encoding-check: allow"))
    .join("\n");
  const matches = scannable.match(MOJIBAKE_RE);
  if (matches && matches.length > 0) {
    const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
    issues.push({
      file: rel,
      kind: "mojibake",
      detail: `${matches.length} cp1252-mojibake sequence(s), arabic chars=${arabic} (fix: py scripts/fix-encoding2.py --apply)`,
    });
  }

  if (path.extname(file).toLowerCase() === ".json") {
    try {
      JSON.parse(text);
    } catch (err) {
      issues.push({ file: rel, kind: "invalid-json", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return issues;
}

export function scanEncoding(rootDir = ROOT): EncodingIssue[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(rootDir, dir);
    if (fs.existsSync(full)) walk(full, files);
  }
  for (const name of SCAN_ROOT_FILES) {
    const full = path.join(rootDir, name);
    if (fs.existsSync(full)) files.push(full);
  }
  const issues: EncodingIssue[] = [];
  for (const file of files) issues.push(...checkFile(file));
  return issues;
}

export function formatIssues(issues: EncodingIssue[]): string {
  return issues.map((i) => `  [${i.kind}] ${i.file} — ${i.detail}`).join("\n");
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("check-encoding.ts");
if (isDirectRun || process.argv.includes("--run")) {
  const issues = scanEncoding();
  if (issues.length === 0) {
    console.log("encoding check: OK (no BOM, no mojibake, all JSON valid)");
  } else {
    console.error(`encoding check: ${issues.length} issue(s)\n${formatIssues(issues)}`);
    process.exitCode = 1;
  }
}
