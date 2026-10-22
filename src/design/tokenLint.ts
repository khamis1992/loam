/**
 * Design token linter (V1 seed, extended by V4).
 *
 * The linter is intentionally small and dependency-free: it walks a generated
 * site directory, scans the UI source files it finds, and reports violations of
 * the Loam UI Kit rules that can be decided statically (raw colours, arbitrary
 * pixel values, too many font families, emoji icons, gradients, missing alt
 * text, and RTL readiness for Arabic locales).
 *
 * V4 replaces the implementation behind the same {@link DesignLinter} interface
 * with a fuller rule set; callers must not depend on the concrete class.
 */

import fs from "node:fs";
import path from "node:path";

export type LintSeverity = "error" | "warn";

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  file: string;
  message: string;
}

export interface LintMetrics {
  /** Number of UI source files that were scanned. */
  files: number;
  rawColors: number;
  arbitraryPx: number;
  fontFamilies: number;
  emoji: number;
  gradients: number;
  missingAlt: number;
  /** False only when an RTL locale is requested and the site is not RTL-ready. */
  rtlReady: boolean;
}

export interface LintResult {
  /** 0-100; 100 means no violations. */
  score: number;
  issues: LintIssue[];
  metrics: LintMetrics;
}

export interface LintOptions {
  locale?: string;
  direction?: "ltr" | "rtl";
}

export interface DesignLinter {
  lintSite(siteDir: string, options?: LintOptions): Promise<LintResult>;
}

const UI_EXTENSIONS = new Set([".html", ".css", ".tsx", ".jsx", ".vue", ".svelte", ".ts", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".next", ".nuxt", "coverage", ".turbo", ".git"]);

/** Tailwind palette utilities (bg-white, text-gray-500, border-blue-600, ...). */
const RAW_COLOR_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|accent|caret|decoration|placeholder|backdrop|highlight)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?\b/g;

/** Arbitrary colour values: text-[#fff], bg-[rgb(1,2,3)], text-[color:...]. */
const ARBITRARY_COLOR = /\[#[\da-fA-F]{3,8}\]|\[rgba?\([^\]]*\)\]|\[hsla?\([^\]]*\)\]|\[color:[^\]]*\]/g;

/** Arbitrary pixel values: w-[133px], p-[13px]. */
const ARBITRARY_PX = /\[\d+(?:\.\d+)?px\]/g;

/** Tailwind gradient utilities or CSS gradients. */
const GRADIENT =
  /\b(?:bg-gradient-to-[a-z]+|bg-\[linear-gradient[^\]]*\]|bg-\[radial-gradient[^\]]*\]|linear-gradient\(|radial-gradient\()/g;

/** Emoji used as iconography (v0/Loam rule: icons come from one icon set). */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

const IMG_WITHOUT_ALT = /<img\b(?![^>]*\balt\s*=)[^>]*>/gi;

const FONT_FAMILY_DECL = /font-family\s*:\s*([^;}]+)/gi;

const LOGICAL_PROPERTY =
  /(?:\b(?:ms|me|ps|pe|start|end)-|\btext-(?:start|end)\b|\bborder-[se]\b|\brounded-[se]\b|\b(?:ms|me|ps|pe)-\[)/;

const GENERIC_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "cursive",
  "fantasy",
  "emoji",
  "math",
  "fangsong",
]);

const ERROR_PENALTY = 8;
const WARN_PENALTY = 3;

/** Arabic and other RTL-script locales that require `dir="rtl"`. */
export function isRtl(locale: string): boolean {
  const tag = (locale || "").trim().toLowerCase();
  return /^(ar|he|fa|ur|ps|sd|ug|yi)\b/.test(tag);
}

/** Resolve the effective text direction for a fixture locale. */
export function resolveDirection(locale: string, explicit?: "ltr" | "rtl"): "ltr" | "rtl" {
  return explicit ?? (isRtl(locale) ? "rtl" : "ltr");
}

interface ScannedFile {
  relative: string;
  text: string;
}

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== "." && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, out);
    } else if (entry.isFile() && UI_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function normalizeFamily(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function distinctFamilies(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FONT_FAMILY_DECL)) {
    const list = match[1] ?? "";
    for (const part of list.split(",")) {
      const family = normalizeFamily(part);
      if (family && !GENERIC_FAMILIES.has(family)) found.add(family);
    }
  }
  for (const match of text.matchAll(/(?<![-\w])font-(sans|serif|mono|heading)\b/g)) {
    const family = match[1];
    if (family) found.add(`token:${family}`);
  }
  return [...found];
}

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  return (text.match(global) ?? []).length;
}

function lintFile(file: ScannedFile, options: LintOptions, issues: LintIssue[]): void {
  const { relative, text } = file;
  const add = (rule: string, severity: LintSeverity, message: string): void => {
    issues.push({ rule, severity, file: relative, message });
  };

  const rawColors = countMatches(text, RAW_COLOR_CLASS) + countMatches(text, ARBITRARY_COLOR);
  if (rawColors > 0) {
    add("raw-color", "error", `raw colour value(s) used instead of a semantic token (${rawColors})`);
  }

  const arbitraryPx = countMatches(text, ARBITRARY_PX);
  if (arbitraryPx > 0) {
    add("arbitrary-px", "warn", `arbitrary pixel value(s) used instead of the spacing scale (${arbitraryPx})`);
  }

  const emoji = countMatches(text, EMOJI);
  if (emoji > 0) {
    add("emoji-icon", "error", `emoji used as an icon or decoration (${emoji})`);
  }

  const gradients = countMatches(text, GRADIENT);
  if (gradients > 0) {
    add("gradient", "warn", `gradient used without an explicit opt-in (${gradients})`);
  }

  const missingAlt = countMatches(text, IMG_WITHOUT_ALT);
  if (missingAlt > 0) {
    add("missing-alt", "error", `image(s) without alt text (${missingAlt})`);
  }

  const families = distinctFamilies(text);
  if (families.length > 2) {
    add("font-families", "warn", `more than two font families used (${families.join(", ")})`);
  }

  const rtlRequested = resolveDirection(options.locale ?? "", options.direction) === "rtl";
  if (rtlRequested) {
    const htmlFile = /\.(html)$/i.test(relative);
    if (htmlFile && !/\bdir\s*=\s*["']rtl["']/i.test(text)) {
      add("rtl-dir", "error", 'missing dir="rtl" on the root element for an RTL locale');
    }
    if (!LOGICAL_PROPERTY.test(text)) {
      add("rtl-logical", "warn", "no logical properties (ms-/me-/ps-/pe-) found for an RTL locale");
    }
  }
}

function computeScore(issues: LintIssue[]): number {
  let score = 100;
  for (const issue of issues) score -= issue.severity === "error" ? ERROR_PENALTY : WARN_PENALTY;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Minimal in-repo linter. V4 swaps this for a fuller implementation while
 * keeping the {@link DesignLinter} contract stable.
 */
export function minimalDesignLinter(): DesignLinter {
  return {
    async lintSite(siteDir: string, options: LintOptions = {}): Promise<LintResult> {
      const root = path.resolve(siteDir);
      const files = collectFiles(root);
      const issues: LintIssue[] = [];
      const scanned: ScannedFile[] = [];
      for (const absolute of files) {
        let text: string;
        try {
          text = fs.readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        scanned.push({ relative: path.relative(root, absolute).split(path.sep).join("/"), text });
      }
      for (const file of scanned) lintFile(file, options, issues);

      const rtlRequested = resolveDirection(options.locale ?? "", options.direction) === "rtl";
      const hasDirRtl = scanned.some((f) => /\.(html)$/i.test(f.relative) && /\bdir\s*=\s*["']rtl["']/i.test(f.text));
      const hasLogical = scanned.some((f) => LOGICAL_PROPERTY.test(f.text));
      const rtlReady = !rtlRequested || (hasDirRtl && hasLogical);

      return {
        score: computeScore(issues),
        issues,
        metrics: {
          files: scanned.length,
          rawColors: issues.filter((i) => i.rule === "raw-color").length,
          arbitraryPx: issues.filter((i) => i.rule === "arbitrary-px").length,
          fontFamilies: new Set(scanned.flatMap((f) => distinctFamilies(f.text))).size,
          emoji: issues.filter((i) => i.rule === "emoji-icon").length,
          gradients: issues.filter((i) => i.rule === "gradient").length,
          missingAlt: issues.filter((i) => i.rule === "missing-alt").length,
          rtlReady,
        },
      };
    },
  };
}
