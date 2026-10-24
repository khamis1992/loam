/**
 * Package-intel heuristics (GuardDog-style ideas, clean-room): typosquatting, install scripts, direct URL
 * dependencies, bundled executables, disposable maintainer domains, and a weighted risk score with cap gates.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReconHit, Score } from "../../audit/types.js";

export const POPULAR_NPM = ["react", "lodash", "express", "axios", "chalk", "commander", "moment", "request", "webpack", "typescript", "eslint", "jquery", "vue", "next", "debug", "dotenv", "uuid", "yargs", "async", "bluebird", "colors", "minimist", "mkdirp", "rimraf", "semver", "underscore", "prettier", "jest", "mocha", "cross-env"];
export const POPULAR_PYPI = ["requests", "numpy", "pandas", "django", "flask", "urllib3", "setuptools", "boto3", "pytest", "scipy", "pillow", "cryptography", "pyyaml", "jinja2", "sqlalchemy", "colorama", "beautifulsoup4", "matplotlib"];
export const DISPOSABLE_DOMAINS = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc"]);

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const norm = (s: string): string => s.toLowerCase().replace(/[-_.]/g, "");

/** The popular package this name imitates, or null. Short names (<5) are skipped: too many false hits. */
export function typosquatOf(name: string, popular: readonly string[]): string | null {
  const bare = name.replace(/^@[^/]+\//, "").toLowerCase();
  if (bare.length < 5 || popular.includes(bare)) return null;
  for (const p of popular) {
    if (levenshtein(bare, p) === 1) return p;
    if (bare !== p && norm(bare) === norm(p)) return p;
    if (bare.length === p.length && [...bare].sort().join("") === [...p].sort().join("") && levenshtein(bare, p) === 2) return p;
  }
  return null;
}

export function executableKind(head: Buffer): string | null {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return "PE/MZ";
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "ELF";
  if (head.length >= 4) {
    const w = head.readUInt32BE(0);
    if (w === 0xfeedface || w === 0xfeedfacf || w === 0xcffaedfe || w === 0xcefaedfe || w === 0xcafebabe) return "Mach-O";
  }
  return null;
}

export interface Signal {
  id: string;
  /** Each 0..1: how bad, how far along an attack chain, how specific, how sophisticated. */
  severity: number; chain: number; specificity: number; sophistication: number;
  metadataOnly?: boolean;
  message: string; file: string; line?: number;
}

export interface RiskVerdict { score: number; label: "low" | "suspicious" | "high" }

/** score = (severity 30% + chain 20% + specificity 30% + sophistication 20%) * 10, with cap gates. */
export function riskScore(signals: Signal[]): RiskVerdict {
  if (signals.length === 0) return { score: 0, label: "low" };
  const top = (k: "severity" | "chain" | "specificity" | "sophistication"): number => Math.max(...signals.map((s) => s[k]));
  let score = (0.3 * top("severity") + 0.2 * top("chain") + 0.3 * top("specificity") + 0.2 * top("sophistication")) * 10;
  if (signals.every((s) => s.specificity < 0.4)) score = Math.min(score, 4.9);
  else if (signals.every((s) => s.metadataOnly)) score = Math.min(score, 6.9);
  score = Math.round(score * 10) / 10;
  return { score, label: score < 5 ? "low" : score < 7 ? "suspicious" : "high" };
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const DOWNLOAD_EXEC = /\b(?:curl|wget|Invoke-WebRequest|iwr)\b|\bchild_process\b|\beval\s*\(|\bpowershell\b|\bbase64\b/i;

export function analyzeManifest(pkgJson: string, file: string): Signal[] {
  let j: Record<string, unknown>;
  try { j = JSON.parse(pkgJson); } catch { return []; }
  const out: Signal[] = [];
  const name = typeof j.name === "string" ? j.name : "";
  const squat = name ? typosquatOf(name, POPULAR_NPM) : null;
  if (squat) out.push({ id: "typosquat", severity: 0.7, chain: 0.5, specificity: 0.6, sophistication: 0.4, metadataOnly: true, message: `package name "${name}" resembles popular package "${squat}"`, file });
  const scripts = (j.scripts && typeof j.scripts === "object" ? j.scripts : {}) as Record<string, unknown>;
  for (const h of INSTALL_HOOKS) {
    const cmd = typeof scripts[h] === "string" ? (scripts[h] as string) : "";
    if (!cmd) continue;
    const risky = DOWNLOAD_EXEC.test(cmd);
    out.push({ id: risky ? "install-script-download-exec" : "install-script", severity: risky ? 0.9 : 0.3, chain: risky ? 0.9 : 0.5, specificity: risky ? 0.8 : 0.3, sophistication: risky ? 0.6 : 0.2, message: `${h} script runs at install time: ${cmd.slice(0, 120)}`, file });
  }
  for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries((j[sec] && typeof j[sec] === "object" ? j[sec] : {}) as Record<string, unknown>)) {
      if (typeof spec === "string" && /^(?:https?:|git\+|git:|github:|file:)/.test(spec) && !spec.startsWith("file:")) {
        out.push({ id: "direct-url-dependency", severity: 0.5, chain: 0.4, specificity: 0.5, sophistication: 0.3, message: `dependency "${dep}" is installed from ${spec.slice(0, 100)}, not the registry`, file });
      }
      const sq = typosquatOf(dep, POPULAR_NPM);
      if (sq) out.push({ id: "typosquat-dependency", severity: 0.7, chain: 0.5, specificity: 0.6, sophistication: 0.4, metadataOnly: true, message: `dependency "${dep}" resembles popular package "${sq}"`, file });
    }
  }
  const authors = [j.author, ...(Array.isArray(j.maintainers) ? j.maintainers : [])];
  for (const a of authors) {
    const email = typeof a === "string" ? /<([^>]+)>/.exec(a)?.[1] : (a as { email?: string } | null)?.email;
    const dom = email?.split("@")[1]?.toLowerCase();
    if (dom && DISPOSABLE_DOMAINS.has(dom)) out.push({ id: "disposable-email", severity: 0.5, chain: 0.3, specificity: 0.5, sophistication: 0.2, metadataOnly: true, message: `maintainer uses disposable email domain ${dom}`, file });
  }
  return out;
}

export function analyzeRequirements(text: string, file: string): Signal[] {
  const out: Signal[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
    if (m) { const sq = typosquatOf(m[1]!, POPULAR_PYPI); if (sq) out.push({ id: "typosquat", severity: 0.7, chain: 0.5, specificity: 0.6, sophistication: 0.4, metadataOnly: true, message: `requirement "${m[1]}" resembles popular package "${sq}"`, file, line: i + 1 }); }
    if (/^\s*(?:git\+|https?:)/.test(l)) out.push({ id: "direct-url-dependency", severity: 0.5, chain: 0.4, specificity: 0.5, sophistication: 0.3, message: `requirement installed from a URL: ${l.trim().slice(0, 100)}`, file, line: i + 1 });
  });
  return out;
}

const SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "vendor"]);
const BIN_EXT = /\.(?:exe|dll|so|dylib|node|bin|o|a)$/i;

export function scanBundledBinaries(root: string, maxFiles = 5000): Signal[] {
  const out: Signal[] = []; let n = 0;
  const walk = (dir: string): void => {
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (n >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
      if (!e.isFile() || e.isSymbolicLink()) continue;
      n++;
      if (!BIN_EXT.test(e.name) && !/^[^.]+$/.test(e.name)) continue;
      let fd = -1;
      try {
        fd = fs.openSync(full, "r");
        const b = Buffer.alloc(4); const got = fs.readSync(fd, b, 0, 4, 0);
        const kind = executableKind(b.subarray(0, got));
        if (kind) out.push({ id: "bundled-binary", severity: 0.6, chain: 0.5, specificity: 0.5, sophistication: 0.4, message: `${kind} executable committed to the repository`, file: path.relative(root, full).split(path.sep).join("/") });
      } catch { /* unreadable */ } finally { if (fd >= 0) try { fs.closeSync(fd); } catch { /* closed */ } }
    }
  };
  walk(root);
  return out;
}

const toScore = (label: RiskVerdict["label"]): Score => (label === "high" ? "high" : label === "suspicious" ? "medium" : "low");

export function signalsToHits(signals: Signal[]): ReconHit[] {
  const byFile = new Map<string, Signal[]>();
  for (const s of signals) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const hits: ReconHit[] = [];
  for (const [file, group] of byFile) {
    const verdict = riskScore(group);
    for (const s of group) {
      hits.push({ tool: "loam-pkg", ruleId: s.id, file, line: s.line ?? 1, cls: "malicious-package", severity: toScore(verdict.label), deterministic: true, message: `${s.message} (file risk ${verdict.score}/10, ${verdict.label})`, raw: { score: verdict.score } });
    }
  }
  return hits;
}

export function runPkgIntel(root: string): ReconHit[] {
  const signals: Signal[] = [];
  const walk = (dir: string): void => {
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      try {
        if (e.name === "package.json") signals.push(...analyzeManifest(fs.readFileSync(full, "utf8"), rel));
        else if (e.name === "requirements.txt") signals.push(...analyzeRequirements(fs.readFileSync(full, "utf8"), rel));
      } catch { /* unreadable */ }
    }
  };
  walk(root);
  signals.push(...scanBundledBinaries(root));
  return signalsToHits(signals);
}
