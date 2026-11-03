/**
 * Loader for the vendored Gitleaks default rule set (rules/loam/secrets/gitleaks.toml,
 * copied verbatim from gitleaks, MIT License). Loam-authored rules in rules.ts win on
 * id collisions; rules whose regex does not compile as JS RegExp are dropped and counted,
 * never fatal. Parsed with smol-toml at scan time so the file stays plain data.
 */
import fs from "node:fs";
import { parse } from "smol-toml";
import type { SecretRule } from "./rules.js";

export interface GlobalAllow { paths: string[]; regexes: string[]; stopwords: string[] }
export interface GitleaksLoad { rules: SecretRule[]; globalAllow: GlobalAllow; dropped: number }

interface TomlAllowlist {
  paths?: string[];
  regexes?: string[];
  stopwords?: string[];
  regexTarget?: string;
}
interface TomlRule {
  id?: string;
  description?: string;
  regex?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  path?: string;
  tags?: string[];
  allowlists?: TomlAllowlist[];
}

/**
 * RE2 -> JS RegExp translation. Go allows inline `(?i)` anywhere; JS does not, so an
 * inline `(?i)` is absorbed into the whole pattern's "i" flag (a slight widening of any
 * literal prefix, harmless for secret matching). Go named groups `(?P<` become `(?<`,
 * and `(?-i:` groups widen to `(?:` (drops case-exactness of that one group). Returns a
 * pattern `compileRe` accepts — a leading "(?i)" is the sentinel requesting the flag —
 * or null when nothing valid remains.
 */
export function toJsPattern(src: string): string | null {
  let body = src;
  let ci = body.startsWith("(?i)");
  if (ci) body = body.slice(4);
  if (body.includes("(?i)")) { body = body.split("(?i)").join(""); ci = true; }
  body = body.split("(?P<").join("(?<");
  if (body.includes("(?-i:")) body = body.split("(?-i:").join("(?:");
  try { new RegExp(body, ci ? "gi" : "g"); } catch { return null; }
  return ci ? `(?i)${body}` : body;
}

export function loadGitleaksRules(tomlPath: string): GitleaksLoad | null {
  let text: string;
  try { text = fs.readFileSync(tomlPath, "utf8"); } catch { return null; }
  let doc: Record<string, unknown>;
  try { doc = parse(text) as Record<string, unknown>; } catch { return null; }

  const global = (doc.allowlist ?? {}) as TomlAllowlist;
  const globalAllow: GlobalAllow = {
    paths: global.paths ?? [],
    regexes: global.regexes ?? [],
    stopwords: (global.stopwords ?? []).map((s) => s.toLowerCase()),
  };

  const rules: SecretRule[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of (doc.rules ?? []) as TomlRule[]) {
    const id = typeof raw.id === "string" ? raw.id : "";
    const regexSrc = typeof raw.regex === "string" ? raw.regex : "";
    if (!id || !regexSrc || seen.has(id)) continue;
    const regex = toJsPattern(regexSrc);
    if (!regex) { dropped++; continue; }
    seen.add(id);

    const allow: SecretRule["allow"] = {};
    for (const a of raw.allowlists ?? []) {
      if (a.paths?.length) allow.paths = [...(allow.paths ?? []), ...a.paths];
      const target = a.regexTarget === "match" || a.regexTarget === "line" ? a.regexTarget : "secret";
      for (const re of a.regexes ?? []) (allow.regexes ??= []).push({ re, target });
      if (a.stopwords?.length) allow.stopwords = [...(allow.stopwords ?? []), ...a.stopwords.map((s) => s.toLowerCase())];
    }

    rules.push({
      id,
      description: typeof raw.description === "string" ? raw.description : id,
      keywords: (raw.keywords ?? []).filter((k): k is string => typeof k === "string"),
      regex,
      ...(typeof raw.secretGroup === "number" ? { secretGroup: raw.secretGroup } : {}),
      ...(typeof raw.entropy === "number" ? { entropy: raw.entropy } : {}),
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      severity: id.startsWith("generic") ? "medium" : "high",
      ...(id.startsWith("generic") ? { generic: true } : {}),
      ...(Object.keys(allow).length ? { allow } : {}),
    });
  }
  return { rules, globalAllow, dropped };
}

/** Vendored gitleaks rules under a rules root, minus ids Loam authors itself. */
export function rulesWithGitleaks(rulesDir: string, loam: SecretRule[]): { rules: SecretRule[]; globalAllow: GlobalAllow } | null {
  const loaded = loadGitleaksRules(`${rulesDir.replace(/[\\/]+$/, "")}/loam/secrets/gitleaks.toml`);
  if (!loaded) return null;
  const mine = new Set(loam.map((r) => r.id));
  return { rules: [...loaded.rules.filter((r) => !mine.has(r.id)), ...loam], globalAllow: loaded.globalAllow };
}
