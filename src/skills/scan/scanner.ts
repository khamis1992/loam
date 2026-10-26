// src/skills/scan/scanner.ts — (MISSING §6.5 reference implementation, tested on the box)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findSecret } from "../../memory/redact.js";
import { RULES, RULESET_VERSION, UNICODE_RULES, ZWJ_OUTSIDE_EMOJI } from "./rules.js";
import type { ScanFinding, ScanOptions, ScanReport, ScanRule, ScanSeverity } from "./types.js";

const ORDER: Record<ScanSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".rb", ".go", ".rs", ".lua", ".php", ".vbs"]);
const TEXT_EXT = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".csv", ".svg", ".ini", ".cfg", ".env", ""]);
const BINARY_EXT = new Set([".exe", ".dll", ".so", ".dylib", ".bin", ".msi", ".scr", ".com", ".jar", ".class", ".pyc", ".wasm", ".node", ".zip", ".7z", ".rar", ".tar", ".gz", ".lnk"]);
const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".mp3", ".mp4", ".wav", ".ttf", ".otf", ".woff", ".woff2"]);
const MAX_LINE = 4000;
const MAX_SEGMENT = 200_000;
const SKILL_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]{0,79}$/u;

export interface ScanFile { rel: string; bytes: Buffer; }

/** Walk a skill directory without following symlinks. Symlinks and over-cap trees become findings, never silent skips. */
export function readSkillTree(dir: string, opts: ScanOptions = {}): { files: ScanFile[]; findings: ScanFinding[]; complete: boolean } {
  const maxFiles = opts.maxFiles ?? 200, maxFile = opts.maxFileBytes ?? 512 * 1024, maxTotal = opts.maxTotalBytes ?? 5 * 1024 * 1024;
  const files: ScanFile[] = []; const findings: ScanFinding[] = []; let total = 0; let complete = true;
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop()!;
    for (const ent of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) { findings.push(mf("LS-MF04", "high", rel, "Symbolic link inside a skill", "رابط رمزي داخل المهارة", "Replace links with real files.")); continue; }
      if (ent.isDirectory()) { if (ent.name !== ".git") stack.push(rel); continue; }
      if (!ent.isFile()) continue;
      const size = fs.statSync(path.join(dir, rel)).size;
      if (files.length >= maxFiles || size > maxFile || total + size > maxTotal) {
        complete = false;
        findings.push(mf("LS-MF05", "high", rel, "Skill exceeds scan limits; not scanned", "المهارة تتجاوز حدود الفحص", "Split or trim the skill."));
        continue;
      }
      total += size;
      files.push({ rel, bytes: fs.readFileSync(path.join(dir, rel)) });
    }
  }
  return { files, findings, complete };
}

function mf(ruleId: string, severity: ScanSeverity, file: string, title: string, titleAr: string, remediation: string, line: number | null = null, excerpt = ""): ScanFinding {
  return { ruleId, category: "manifest", severity, file, line, excerpt, title, titleAr, remediation };
}

/** Split markdown into prose and fenced-code segments, keeping 1-based line numbers. */
function segments(text: string, isCodeFile: boolean): Array<{ scope: "prose" | "code"; startLine: number; lines: string[] }> {
  const lines = text.split(/\r?\n/);
  if (isCodeFile) return [{ scope: "code", startLine: 1, lines }];
  const out: Array<{ scope: "prose" | "code"; startLine: number; lines: string[] }> = [];
  let cur = { scope: "prose" as "prose" | "code", startLine: 1, lines: [] as string[] };
  let fence: string | null = null;
  lines.forEach((ln, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(ln);
    if (m && (fence === null || m[1]!.startsWith(fence))) {
      out.push(cur);
      fence = fence === null ? m[1]! : null;
      cur = { scope: fence === null ? "prose" : "code", startLine: i + 2, lines: [] };
      return;
    }
    cur.lines.push(ln);
  });
  out.push(cur);
  return out.filter((s) => s.lines.length);
}

function applies(rule: ScanRule, scope: "prose" | "code"): boolean { return rule.scope === "any" || rule.scope === scope; }
const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s).replace(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069]/gu, "·");

export function scanFiles(files: ScanFile[], pre: ScanFinding[] = [], complete = true, opts: ScanOptions = {}): ScanReport {
  const skip = new Set(opts.skipRules ?? []);
  const findings: ScanFinding[] = [...pre];
  let bytes = 0;
  const hashLines: string[] = [];
  const skillMd = files.find((f) => f.rel === "SKILL.md");
  if (!skillMd) findings.push(mf("LS-MF01", "high", "SKILL.md", "SKILL.md is missing", "ملف SKILL.md مفقود", "A skill needs SKILL.md at its root."));

  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    bytes += f.bytes.length;
    hashLines.push(`${f.rel}\0${crypto.createHash("sha256").update(f.bytes).digest("hex")}`);
    const ext = path.extname(f.rel).toLowerCase();
    const base = path.basename(f.rel).toLowerCase();
    if (BINARY_EXT.has(ext)) { findings.push(mf("LS-MF03", "high", f.rel, "Executable or archive inside a skill", "ملف تنفيذي أو أرشيف داخل المهارة", "Skills are text; remove binaries.")); continue; }
    if (MEDIA_EXT.has(ext)) continue;
    if ((base === ".env" || base.startsWith(".env.")) && !/\.(example|sample|template|dist)$/.test(base)) findings.push({ ruleId: "LS-SK02", category: "secret", severity: "high", file: f.rel, line: null, excerpt: "", title: "Environment file shipped with the skill", titleAr: "ملف بيئة مرفق بالمهارة", remediation: "Remove .env files." });
    if (!CODE_EXT.has(ext) && !TEXT_EXT.has(ext)) continue;
    const text = f.bytes.toString("utf8");
    const isCode = CODE_EXT.has(ext);

    // Unicode: whole file, per line.
    text.split(/\r?\n/).forEach((ln, i) => {
      for (const u of UNICODE_RULES) if (!skip.has(u.id) && u.re.test(i === 0 ? ln : ln.replace(/^\uFEFF/u, "\u200B"))) {
        if (u.id === "LS-UC03" && i === 0 && /^\uFEFF/u.test(ln) && !/[\u200B\u2060\u2061-\u2064\u180E]|.\uFEFF/u.test(ln)) continue; // leading BOM is fine
        findings.push({ ruleId: u.id, category: "unicode", severity: u.severity, file: f.rel, line: i + 1, excerpt: clip(ln), title: u.title, titleAr: u.titleAr, remediation: "Remove the invisible character." });
      }
      if (!skip.has("LS-UC06") && ZWJ_OUTSIDE_EMOJI.test(ln)) findings.push({ ruleId: "LS-UC06", category: "unicode", severity: "medium", file: f.rel, line: i + 1, excerpt: clip(ln), title: "Zero-width joiner outside an emoji", titleAr: "محرف ربط صفري خارج رمز تعبيري", remediation: "Remove the invisible character." });
      const secret = skip.has("LS-SK01") ? null : findSecret(ln);
      if (secret) findings.push({ ruleId: "LS-SK01", category: "secret", severity: secret.startsWith("\\b(password") ? "medium" : "high", file: f.rel, line: i + 1, excerpt: "[redacted]", title: "Possible credential", titleAr: "بيانات اعتماد محتملة", remediation: "Remove the credential and rotate it." });
    });

    for (const seg of segments(text, isCode)) {
      for (const rule of RULES) {
        if (skip.has(rule.id) || !applies(rule, seg.scope)) continue;
        if (rule.htmlComments) {
          // Linear scan with indexOf: no regex over the whole segment (ReDoS-safe).
          const joined = seg.lines.join("\n").slice(0, MAX_SEGMENT);
          for (let at = joined.indexOf("<!--"); at >= 0; ) {
            const end = joined.indexOf("-->", at + 4);
            const inner = joined.slice(at + 4, end < 0 ? joined.length : end).slice(0, MAX_LINE);
            if (rule.patterns.some((re) => re.test(inner))) {
              const line = seg.startLine + joined.slice(0, at).split("\n").length - 1;
              findings.push({ ruleId: rule.id, category: rule.category, severity: rule.severity, file: f.rel, line, excerpt: clip(inner.trim()), title: rule.title, titleAr: rule.titleAr, remediation: rule.remediation });
              break;
            }
            if (end < 0) break;
            at = joined.indexOf("<!--", end + 3);
          }
          continue;
        }
        seg.lines.forEach((raw, i) => {
          const ln = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw; // bound regex work per line (ReDoS budget)
          if (rule.patterns.some((re) => re.test(ln))) findings.push({ ruleId: rule.id, category: rule.category, severity: rule.severity, file: f.rel, line: seg.startLine + i, excerpt: clip(ln.trim()), title: rule.title, titleAr: rule.titleAr, remediation: rule.remediation });
        });
      }
    }
  }

  if (skillMd) findings.push(...manifestChecks(skillMd.bytes.toString("utf8")));
  const dedup = new Map<string, ScanFinding>();
  for (const f of findings) dedup.set(`${f.ruleId}|${f.file}|${f.line ?? ""}`, f);
  const list = [...dedup.values()].sort((a, b) => ORDER[b.severity] - ORDER[a.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const stats: Record<ScanSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of list) stats[f.severity]++;
  const failAt = ORDER[opts.failOn ?? "high"];
  const verdict = !complete || list.some((f) => ORDER[f.severity] >= failAt) ? "fail" : list.some((f) => ORDER[f.severity] >= ORDER.medium) ? "warn" : "pass";
  return { rulesetVersion: RULESET_VERSION, verdict, complete, files: files.length, bytes, stats, findings: list,
    contentHash: crypto.createHash("sha256").update(hashLines.join("\n")).digest("hex") };
}

/** Frontmatter checks that respect Arabic names. */
function manifestChecks(raw: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const m = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(raw);
  if (!m) return [mf("LS-MF01", "medium", "SKILL.md", "No YAML frontmatter", "لا توجد ترويسة YAML", "Start SKILL.md with ---, name and description.")];
  const fm = m[1]!;
  const name = /^name\s*:\s*["']?(.*?)["']?\s*$/m.exec(fm)?.[1]?.trim() ?? "";
  const desc = /^description\s*:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? "";
  if (!name || !SKILL_NAME_RE.test(name)) out.push(mf("LS-MF01", "medium", "SKILL.md", "Frontmatter name is missing or invalid", "اسم المهارة مفقود أو غير صالح", "Use letters (Arabic or Latin), digits, space, dot, dash or underscore.", 2));
  if (!desc) out.push(mf("LS-MF02", "low", "SKILL.md", "Frontmatter description is empty", "وصف المهارة فارغ", "Add a one-line description.", 2));
  if (/^(system|instructions?|prompt|role)\s*:/im.test(fm)) out.push(mf("LS-MF07", "high", "SKILL.md", "Frontmatter carries prompt-like keys", "الترويسة تحمل مفاتيح تعليمات", "Only name, description, triggers and known metadata keys are allowed.", 2));
  return out;
}

export function scanSkillDir(dir: string, opts: ScanOptions = {}): ScanReport {
  const { files, findings, complete } = readSkillTree(dir, opts);
  return scanFiles(files, findings, complete, opts);
}
