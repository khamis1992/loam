/**
 * Lockfile and SBOM parsers. Each returns exact pinned packages; matching against advisories
 * happens in osvClient. Parsers ported from cve-intel deps.rs (MIT/Apache-2.0, Fazmin/cve-intel):
 * purl, CycloneDX, SPDX (JSON + tag-value), yarn berry, go.mod, pom.xml with ${property} resolution,
 * free-form purl lines, UTF-16/BOM tolerance, manifest pinning.
 */
import fs from "node:fs";
import path from "node:path";

export interface Pkg { ecosystem: "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems" | "Packagist" | "Maven"; name: string; version: string; file: string }

const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Read text tolerating UTF-16 (PowerShell `pip freeze | Out-File`) and BOMs; null when unreadable or oversized. */
export function readText(p: string): string | null {
  let buf: Buffer;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    buf = fs.readFileSync(p);
  } catch { return null; }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return swap16(buf).toString("utf16le");
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}
const swap16 = (buf: Buffer): Buffer => {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) { out[i] = buf[i + 1]!; out[i + 1] = buf[i]!; }
  return out;
};

const read = readText;

// ── purl ─────────────────────────────────────────────────────────────────────

const PURL_ECOS: Partial<Record<string, Pkg["ecosystem"]>> = {
  npm: "npm", pypi: "PyPI", golang: "Go", cargo: "crates.io", gem: "RubyGems", composer: "Packagist", maven: "Maven",
};

/** `pkg:type/namespace/name@version` -> Pkg; null for purl types we cannot check against OSV. */
export function parsePurl(purl: string, file: string): Pkg | null {
  let s = purl.trim();
  if (!s.startsWith("pkg:")) return null;
  s = s.slice(4).split("#")[0]!.split("?")[0]!;
  const at = s.lastIndexOf("@");
  if (at < 0) return null;
  const version = decodeURIComponent(s.slice(at + 1));
  const body = s.slice(0, at);
  const slash = body.indexOf("/");
  if (slash < 0) return null;
  const eco = PURL_ECOS[body.slice(0, slash).toLowerCase()];
  if (!eco || !version) return null;
  const name = body.slice(slash + 1).split("/").map((seg) => decodeURIComponent(seg)).join("/");
  if (!name) return null;
  return { ecosystem: eco, name: eco === "PyPI" ? name.toLowerCase().replace(/[_.]+/g, "-") : name, version, file };
}

// ── existing lockfile parsers ────────────────────────────────────────────────

export function parsePackageLock(text: string, file: string): Pkg[] {
  let j: { packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, { version?: string; dependencies?: unknown }> };
  try { j = JSON.parse(text); } catch { return []; }
  const out: Pkg[] = [];
  if (j.packages) {
    for (const [k, v] of Object.entries(j.packages)) {
      const i = k.lastIndexOf("node_modules/");
      if (i < 0 || v.link || !v.version) continue;
      out.push({ ecosystem: "npm", name: k.slice(i + 13), version: v.version, file });
    }
  } else if (j.dependencies) {
    const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>): void => {
      for (const [n, v] of Object.entries(deps)) {
        if (v.version && /^\d/.test(v.version)) out.push({ ecosystem: "npm", name: n, version: v.version, file });
        if (v.dependencies) walk(v.dependencies as typeof deps);
      }
    };
    walk(j.dependencies);
  }
  return out;
}

export function parseYarnLock(text: string, file: string): Pkg[] {
  const out: Pkg[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.includes("__metadata:")) continue; // yarn berry header handled by parseYarnBerry
    const head = /^"?((?:@[^/@"]+\/)?[^@"\s]+)@/m.exec(block);
    const ver = /^\s+version:?\s+"?([^"\s]+)"?/m.exec(block);
    if (head && ver) out.push({ ecosystem: "npm", name: head[1]!, version: ver[1]!, file });
  }
  return out;
}

/** Yarn berry (`__metadata:` sentinel): one entry per `resolution: "name@npm:version"`. */
export function parseYarnBerry(text: string, file: string): Pkg[] {
  if (!text.includes("__metadata:")) return [];
  const out: Pkg[] = [];
  for (const m of text.matchAll(/resolution:\s*"?((?:@[^/@"\s]+\/)?[^@"\s]+)@(npm|patch|workspace|link|file):([^"\s@]+)"?/g)) {
    if (m[2] !== "npm" && m[2] !== "patch") continue;
    out.push({ ecosystem: "npm", name: m[1]!, version: m[3]!, file });
  }
  return out;
}

export function parsePnpmLock(text: string, file: string): Pkg[] {
  const out: Pkg[] = [];
  for (const m of text.matchAll(/^\s{2}\/?'?((?:@[^/@'\s]+\/)?[^@'\s/][^@'\s]*)@(\d[^'(:\s]*)[^\n]*:\s*$/gm)) {
    out.push({ ecosystem: "npm", name: m[1]!, version: m[2]!, file });
  }
  return out;
}

export function parseGoSum(text: string, file: string): Pkg[] {
  const seen = new Set<string>(); const out: Pkg[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+v([^\s/]+)(?:\/go\.mod)?\s/.exec(l + " ");
    if (!m || l.includes("/go.mod")) continue;
    const k = `${m[1]}@${m[2]}`;
    if (!seen.has(k)) { seen.add(k); out.push({ ecosystem: "Go", name: m[1]!, version: m[2]!, file }); }
  }
  return out;
}

/** go.mod direct and indirect requires; go.sum beside it wins (discover enforces the pinning rule). */
export function parseGoMod(text: string, file: string): Pkg[] {
  const seen = new Set<string>(); const out: Pkg[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, "").trim();
    if (!l || /^(module|go|toolchain|tool)\b/.test(l)) continue;
    const m = /^(?:require\s+)?(\S+)\s+(v[0-9][^\s]*)$/.exec(l);
    if (!m) continue;
    const k = `${m[1]}@${m[2]}`;
    if (!seen.has(k)) { seen.add(k); out.push({ ecosystem: "Go", name: m[1]!, version: m[2]!, file }); }
  }
  return out;
}

/** requirements.txt: only exact `==` pins are real versions. */
export function parseRequirements(text: string, file: string): Pkg[] {
  const out: Pkg[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.+!_-]+)/.exec(l);
    if (m) out.push({ ecosystem: "PyPI", name: m[1]!.toLowerCase().replace(/[_.]+/g, "-"), version: m[2]!, file });
  }
  return out;
}

/** poetry.lock, uv.lock and Cargo.lock share the `[[package]]` TOML shape. */
function parseTomlPackages(text: string, file: string, eco: Pkg["ecosystem"]): Pkg[] {
  const out: Pkg[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const n = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const v = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (n && v) out.push({ ecosystem: eco, name: n[1]!, version: v[1]!, file });
  }
  return out;
}
export const parsePoetryLock = (t: string, f: string): Pkg[] => parseTomlPackages(t, f, "PyPI");
export const parseCargoLock = (t: string, f: string): Pkg[] => parseTomlPackages(t, f, "crates.io");

export function parsePipfileLock(text: string, file: string): Pkg[] {
  let j: Record<string, Record<string, { version?: string }>>;
  try { j = JSON.parse(text); } catch { return []; }
  const out: Pkg[] = [];
  for (const sec of ["default", "develop"]) {
    for (const [n, v] of Object.entries(j[sec] ?? {})) if (v.version?.startsWith("==")) out.push({ ecosystem: "PyPI", name: n, version: v.version.slice(2), file });
  }
  return out;
}

export function parseGemfileLock(text: string, file: string): Pkg[] {
  const out: Pkg[] = [];
  for (const m of text.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([0-9][^)\s-]*)[^)]*\)$/gm)) out.push({ ecosystem: "RubyGems", name: m[1]!, version: m[2]!, file });
  return out;
}

export function parseComposerLock(text: string, file: string): Pkg[] {
  let j: { packages?: { name: string; version: string }[]; "packages-dev"?: { name: string; version: string }[] };
  try { j = JSON.parse(text); } catch { return []; }
  return [...(j.packages ?? []), ...(j["packages-dev"] ?? [])].map((p) => ({ ecosystem: "Packagist" as const, name: p.name, version: p.version.replace(/^v/, ""), file }));
}

// ── SBOM parsers (CycloneDX / SPDX) ──────────────────────────────────────────

/** Optional accumulator for purls whose type we cannot check against OSV. */
export interface SkipCount { unsupported: number }

const purlsOf = (blocks: unknown[], out: Pkg[], file: string, acc?: SkipCount): void => {
  for (const bRaw of blocks) {
    const b = bRaw as Record<string, unknown>;
    if (typeof b.purl === "string") {
      const p = parsePurl(b.purl, file);
      if (p) out.push(p);
      else if (acc) acc.unsupported++;
    }
    if (Array.isArray(b.components)) purlsOf(b.components, out, file, acc);
  }
};

/** CycloneDX JSON (`bomFormat: "CycloneDX"`), including nested components. */
export function parseCycloneDx(text: string, file: string, acc?: SkipCount): Pkg[] {
  let j: { bomFormat?: string; components?: unknown[] };
  try { j = JSON.parse(text); } catch { return []; }
  if (j.bomFormat !== "CycloneDX" || !Array.isArray(j.components)) return [];
  const out: Pkg[] = [];
  purlsOf(j.components, out, file, acc);
  return out;
}

/** SPDX JSON: `packages[].externalRefs` entries of category/package-manager with purl. */
export function parseSpdxJson(text: string, file: string, acc?: SkipCount): Pkg[] {
  let j: { spdxVersion?: string; packages?: { externalRefs?: { referenceType?: string; referenceLocator?: string }[] }[] };
  try { j = JSON.parse(text); } catch { return []; }
  if (typeof j.spdxVersion !== "string" || !Array.isArray(j.packages)) return [];
  const out: Pkg[] = [];
  for (const p of j.packages) {
    for (const r of p.externalRefs ?? []) {
      if (r.referenceType !== "purl" || typeof r.referenceLocator !== "string") continue;
      const pkg = parsePurl(r.referenceLocator, file);
      if (pkg) out.push(pkg);
      else if (acc) acc.unsupported++;
    }
  }
  return out;
}

/** SPDX tag-value text: `ExternalRef: PACKAGE-MANAGER purl pkg:...` lines. */
export function parseSpdxTagValue(text: string, file: string, acc?: SkipCount): Pkg[] {
  const out: Pkg[] = [];
  for (const m of text.matchAll(/purl\s+(pkg:\S+)/g)) {
    const pkg = parsePurl(m[1]!, file);
    if (pkg) out.push(pkg);
    else if (acc) acc.unsupported++;
  }
  return out;
}

/** Any SBOM-shaped document: try CycloneDX JSON, SPDX JSON, then SPDX tag-value. */
export function parseSbom(text: string, file: string, acc?: SkipCount): Pkg[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const cdx = parseCycloneDx(text, file, acc);
    if (cdx.length) return cdx;
    return parseSpdxJson(text, file, acc);
  }
  if (/^SPDXVersion:/m.test(text)) return parseSpdxTagValue(text, file, acc);
  return [];
}

// ── pom.xml and free-form lists ──────────────────────────────────────────────

/** pom.xml dependencies with `${property}` resolution from `<properties>`. */
export function parsePomXml(text: string, file: string): Pkg[] {
  const props = new Map<string, string>();
  const propBlock = /<properties>([\s\S]*?)<\/properties>/.exec(text);
  if (propBlock) {
    for (const m of propBlock[1]!.matchAll(/<([A-Za-z][\w.-]*)>([^<]+)<\/\1>/g)) props.set(m[1]!, m[2]!.trim());
  }
  const resolve = (v: string): string => {
    let out = v.trim();
    for (let i = 0; i < 5; i++) out = out.replace(/\$\{([^}]+)\}/g, (_, k: string) => props.get(k) ?? "");
    return out.trim();
  };
  const out: Pkg[] = [];
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = /<groupId>([^<]+)<\/groupId>/.exec(m[1]!)?.[1]?.trim();
    const a = /<artifactId>([^<]+)<\/artifactId>/.exec(m[1]!)?.[1]?.trim();
    const vRaw = /<version>([^<]+)<\/version>/.exec(m[1]!)?.[1];
    const v = vRaw ? resolve(vRaw) : "";
    if (g && a && v && !v.includes("${")) out.push({ ecosystem: "Maven", name: `${g}:${a}`, version: v, file });
  }
  return out;
}

const ECO_BY_NAME = new Map<string, Pkg["ecosystem"]>([
  ["npm", "npm"], ["PyPI", "PyPI"], ["Go", "Go"], ["crates.io", "crates.io"], ["RubyGems", "RubyGems"], ["Packagist", "Packagist"], ["Maven", "Maven"],
]);

/** Free-form lines: mixed `pkg:` purls and `name:ecosystem:version` triples. */
export function parseLines(text: string, file: string, acc?: SkipCount): Pkg[] {
  const out: Pkg[] = [];
  for (const l of text.split(/\r?\n/)) {
    const s = l.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("pkg:")) {
      const p = parsePurl(s, file);
      if (p) out.push(p);
      else if (acc) acc.unsupported++;
      continue;
    }
    const m = /^([^\s:]+):([A-Za-z0-9_.-]+):(\S+)$/.exec(s);
    if (m) {
      const eco = ECO_BY_NAME.get(m[2]!);
      if (eco) out.push({ ecosystem: eco, name: m[1]!, version: m[3]!, file });
    }
  }
  return out;
}

// ── discovery ────────────────────────────────────────────────────────────────

const PARSERS: Record<string, (t: string, f: string, acc?: SkipCount) => Pkg[]> = {
  "package-lock.json": parsePackageLock, "npm-shrinkwrap.json": parsePackageLock, "yarn.lock": parseYarnLock,
  "pnpm-lock.yaml": parsePnpmLock, "go.sum": parseGoSum, "go.mod": parseGoMod, "requirements.txt": parseRequirements,
  "poetry.lock": parsePoetryLock, "uv.lock": parsePoetryLock, "Cargo.lock": parseCargoLock,
  "Pipfile.lock": parsePipfileLock, "Gemfile.lock": parseGemfileLock, "composer.lock": parseComposerLock,
  "pom.xml": parsePomXml, "bom.json": parseSbom, "sbom.json": parseSbom, "dependencies.txt": parseLines,
};
const SKIP = new Set([".git", "node_modules", "dist", "build", "vendor", ".venv", "target"]);

const sbomSuffix = (name: string): boolean => /\.(cdx|spdx)\.json$/i.test(name) || /\.spdx$/i.test(name);

export interface Discovered { pkgs: Pkg[]; unsupported: number; files: number }

/** Walk a project root for lockfiles, manifests and SBOMs. Manifest pinning: go.sum shadows go.mod. */
export function discover(root: string, maxFiles = 200): Discovered {
  const pkgs: Pkg[] = [];
  const acc: SkipCount = { unsupported: 0 };
  let files = 0;
  const walk = (dir: string): void => {
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (files >= maxFiles) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!e.isFile()) continue;
      const parse = PARSERS[e.name] ?? (sbomSuffix(e.name) ? parseSbom : undefined);
      if (!parse) continue;
      if (e.name === "go.mod" && fs.existsSync(path.join(dir, "go.sum"))) continue; // pinned by go.sum
      const text = read(path.join(dir, e.name));
      if (text === null) continue;
      files++;
      pkgs.push(...parse(text, path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"), acc));
    }
  };
  walk(root);
  return { pkgs, unsupported: acc.unsupported, files };
}

/** Compat wrapper for callers that only want the package list. */
export function discoverPackages(root: string, maxFiles = 200): Pkg[] {
  return discover(root, maxFiles).pkgs;
}
