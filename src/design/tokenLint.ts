/**
 * Loam UI Kit token linter.
 *
 * This module offers two complementary, dependency-free views of the same design
 * rules, and both are part of the public contract:
 *
 *  1. {@link lintDesignSource} checks a single in-memory source string (a
 *     TSX/HTML/CSS/JS file, or a whole concatenated bundle). It never executes
 *     the input and never reads the filesystem; it returns a deterministic list
 *     of violations with 1-based line/column coordinates. The `design_lint`
 *     agent tool wraps it so the model can audit a task workspace without a
 *     shell round-trip, and the pipeline can call it directly.
 *  2. {@link minimalDesignLinter} walks a generated site directory and reports a
 *     0-100 score plus a compact issue list. The design eval harness
 *     (src/scripts/eval-design.ts) and its critique step consume this shape, and
 *     its pluggable {@link DesignLinter} interface lets the harness run with a
 *     deterministic mock offline.
 *
 * Rules enforced for every source:
 *  - raw-colour              literal colours (hex/rgb/hsl/oklch/named/Tailwind
 *                            colour utilities) where a semantic token is expected
 *  - too-many-colours        more than `maxColours` distinct colours in one source
 *  - too-many-fonts          more than `maxFonts` distinct font families in one source
 *  - arbitrary-px            arbitrary `[Npx]` Tailwind values and inline px on layout
 *  - emoji-icon              emoji used as UI affordances
 *  - missing-alt             `<img>` without an `alt` attribute
 *  - gradient                decorative gradient backgrounds
 *  - rtl-logical-properties  physical directional properties under an RTL layout
 *  - rtl-direction           Arabic content without `dir="rtl"`
 *
 * Written in Loam's own words; the thresholds mirror the UI Kit spec, not any
 * third-party prompt text.
 *
 * Provenance: this module is the V4 implementation of the design linter. It
 * supersedes the V1 seed carried by manus-parity, which walked the same site
 * directory and reported the same UI Kit rules in a coarser vocabulary. V4
 * keeps the same {@link DesignLinter} contract while adding a source-string
 * view and a finer rule set; callers must not depend on the concrete class.
 */

import fs from "node:fs";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Shared rule constants                                                      */
/* -------------------------------------------------------------------------- */

export type DesignViolationCategory =
  | "raw-colour"
  | "too-many-colours"
  | "too-many-fonts"
  | "arbitrary-px"
  | "emoji-icon"
  | "missing-alt"
  | "gradient"
  | "rtl-logical-properties"
  | "rtl-direction";

export const DESIGN_VIOLATION_CATEGORIES: readonly DesignViolationCategory[] = [
  "raw-colour",
  "too-many-colours",
  "too-many-fonts",
  "arbitrary-px",
  "emoji-icon",
  "missing-alt",
  "gradient",
  "rtl-logical-properties",
  "rtl-direction",
];

export interface DesignViolation {
  category: DesignViolationCategory;
  /** Human-readable, actionable message. */
  message: string;
  /** 1-based line of the offending token. */
  line: number;
  /** 1-based UTF-16 column of the offending token. */
  column: number;
  /** Short excerpt of the source line for display. */
  snippet: string;
}

export interface DesignLintOptions {
  /** Maximum number of distinct colours (default 5). */
  maxColours?: number;
  /** Maximum number of distinct font families (default 2). */
  maxFonts?: number;
  /** Literal colour values that are explicitly allowed (normalised). */
  allowedColours?: readonly string[];
  /** Rules to skip. */
  disabled?: readonly DesignViolationCategory[];
  /** Ignore CSS custom-property definitions (token files). Default true. */
  ignoreTokenDefinitions?: boolean;
}

export interface DesignLintSummary {
  colours: number;
  fonts: number;
  counts: Record<DesignViolationCategory, number>;
}

export interface DesignLintResult {
  /** True when no enabled rule produced a violation. */
  ok: boolean;
  source: string;
  violations: DesignViolation[];
  summary: DesignLintSummary;
}

export const DEFAULT_MAX_COLOURS = 5;
export const DEFAULT_MAX_FONTS = 2;

/** Tailwind palette stems that indicate a raw colour utility (not a token). */
const TAILWIND_COLOUR_STEMS = [
  "slate", "gray", "grey", "zinc", "neutral", "stone", "red", "orange",
  "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky",
  "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];

/** Colour utilities that are always raw (no shade number). */
const TAILWIND_RAW_BASES = ["white", "black", "transparent", "current", "inherit"];

/** Tailwind utility prefixes that can carry a colour. */
const COLOUR_UTILITY_PREFIXES = [
  "bg", "text", "border", "ring", "from", "via", "to", "fill", "stroke",
  "outline", "decoration", "divide", "placeholder", "accent", "caret", "shadow",
];

/**
 * Matches a colour utility (e.g. `bg-slate-500`, `text-[#ff0000]`,
 * `border-border`). Group 1 is the full utility, group 2 the colour part.
 */
const UTILITY_RE = new RegExp(
  `(?:^|[\\s"'\`])((?:${COLOUR_UTILITY_PREFIXES.join("|")})-((?:\\[[^\\]]*\\]|[^\\s"'\`]*)))`,
  "g",
);

const SHADE_RE = new RegExp(`^(?:${TAILWIND_COLOUR_STEMS.join("|")})-\\d{1,3}$`, "i");
const STEM_RE = new RegExp(`^(?:${TAILWIND_COLOUR_STEMS.join("|")})$`, "i");
const RAW_BASE_RE = new RegExp(`^(?:${TAILWIND_RAW_BASES.join("|")})$`, "i");

const HEX_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const RGB_RE = /\brgba?\([^)]*\)/gi;
const HSL_RE = /\bhsla?\([^)]*\)/gi;
const OKLCH_RE = /\b(?:oklch|oklab|lab|lch)\([^)]*\)/gi;

/** CSS declarations whose value is a colour, in CSS or inline-style form. */
const COLOUR_DECL_RE =
  /(?:^|[;{,\s])(color|background(?:-color)?|background-image|border(?:-color)?|fill|stroke)\s*:\s*['"]?([a-z]+)['"]?/gi;

/** Tailwind arbitrary value that is a pixel length, e.g. `text-[13px]`. */
const ARBITRARY_PX_RE = /-\[(\d+(?:\.\d+)?)px\]/g;
/** Inline-style numeric px on layout/typography properties. The lookbehind keeps
 * the shorthand sides (`bottom` in `border-bottom`, `left` in `border-left`) from
 * matching, so a 1px border is not misread as an off-scale layout value. */
const INLINE_PX_RE =
  /(?<![-\w])(?:fontSize|width|height|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginTop|marginRight|marginBottom|marginLeft|gap|top|left|right|bottom|borderRadius)\s*:\s*['"]?(\d+(?:\.\d+)?)px\b/gi;

const FONT_FAMILY_RE = /(?:^|[;{\s])(?:font-family|fontFamily)\s*:\s*["']?([^;}"'`]+)["']?/gi;
/**
 * Tailwind font utilities (`font-sans`, `font-heading`). The negative lookahead
 * keeps the CSS keyword `font-family:` from being read as a `font-` utility,
 * which would otherwise inject a phantom family into every stylesheet.
 */
const FONT_UTILITY_RE = /(?:^|[\s"'`])font-(?!family\b)([a-z0-9-]+)/gi;

/**
 * Generic CSS font families. They are fallbacks, not design decisions, so they
 * never count against the two-family limit.
 */
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

const IMG_RE = /<img\b[^>]*>/gi;
const ALT_ATTR_RE = /\balt\s*=/i;

const GRADIENT_RE =
  /(?:bg-gradient-to-[a-z]+|bg-linear-\d+deg|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\()/gi;

const EMOJI_RE =
  /\p{Emoji_Presentation}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})*(?:\u200D\p{Emoji_Presentation}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})*)*/gu;

/**
 * A declaration of CSS custom properties, e.g. `--primary: oklch(...)`.
 * The lookbehind keeps a hand-written `var(--x)` reference from looking like a
 * declaration, and the separator is required so a value such as `red --note`
 * is not mistaken for a second declaration.
 */
const TOKEN_DEFINITION_RE = /(?<![\w-])--[\w-]+\s*:\s*[^;]*?(?:;|(?=\s+--[\w-]+\s*:)|$)/g;

/** A declared right-to-left direction, in JSX, HTML or inline style form. */
const RTL_DIR_RE = /(?:dir\s*=\s*["']?rtl["']?|dir\s*:\s*["']rtl["'])/i;

/**
 * Logical (direction-agnostic) properties that make a layout RTL-safe. Their
 * presence is what lets a right-to-left page mirror instead of staying pinned
 * to one side.
 */
const LOGICAL_PROPERTY_RE =
  /(?:\b(?:ms|me|ps|pe|start|end)-|\btext-(?:start|end)\b|\bborder-[se]\b|\brounded-[se]\b|\b(?:ms|me|ps|pe)-\[)/;

/** Arabic script (letters, presentation forms and extended blocks). */
const ARABIC_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Physical directional properties that must become logical ones under RTL.
 * `ml-*` becomes `ms-*`, `padding-left` becomes `padding-inline-start`, and so
 * on, so the layout mirrors instead of staying pinned to one side.
 */
const PHYSICAL_DIRECTIONAL: Array<{ re: RegExp; logical: string }> = [
  { re: /(?:^|[\s"'`])ml-[a-z0-9\[]/gi, logical: "ms-*" },
  { re: /(?:^|[\s"'`])mr-[a-z0-9\[]/gi, logical: "me-*" },
  { re: /(?:^|[\s"'`])pl-[a-z0-9\[]/gi, logical: "ps-*" },
  { re: /(?:^|[\s"'`])pr-[a-z0-9\[]/gi, logical: "pe-*" },
  { re: /(?:^|[\s"'`])left-[a-z0-9\[]/gi, logical: "start-*" },
  { re: /(?:^|[\s"'`])right-[a-z0-9\[]/gi, logical: "end-*" },
  { re: /(?:^|[\s"'`])text-left\b/gi, logical: "text-start" },
  { re: /(?:^|[\s"'`])text-right\b/gi, logical: "text-end" },
  { re: /(?:^|[\s"'`])border-l-[a-z0-9\[]/gi, logical: "border-s-*" },
  { re: /(?:^|[\s"'`])border-r-[a-z0-9\[]/gi, logical: "border-e-*" },
  { re: /(?:^|[\s"'`])rounded-l-[a-z0-9\[]/gi, logical: "rounded-s-*" },
  { re: /(?:^|[\s"'`])rounded-r-[a-z0-9\[]/gi, logical: "rounded-e-*" },
  { re: /\bmargin-left\s*:/gi, logical: "margin-inline-start" },
  { re: /\bmargin-right\s*:/gi, logical: "margin-inline-end" },
  { re: /\bpadding-left\s*:/gi, logical: "padding-inline-start" },
  { re: /\bpadding-right\s*:/gi, logical: "padding-inline-end" },
  { re: /\bborder-left\s*:/gi, logical: "border-inline-start" },
  { re: /\bborder-right\s*:/gi, logical: "border-inline-end" },
  { re: /\btext-align\s*:\s*(?:left|right)\b/gi, logical: "text-align: start/end" },
  // React inline-style camelCase form.
  { re: /\bmarginLeft\s*:/gi, logical: "marginInlineStart" },
  { re: /\bmarginRight\s*:/gi, logical: "marginInlineEnd" },
  { re: /\bpaddingLeft\s*:/gi, logical: "paddingInlineStart" },
  { re: /\bpaddingRight\s*:/gi, logical: "paddingInlineEnd" },
  { re: /\bborderLeft\s*:/gi, logical: "borderInlineStart" },
  { re: /\bborderRight\s*:/gi, logical: "borderInlineEnd" },
  { re: /\btextAlign\s*:\s*(?:left|right)\b/gi, logical: "textAlign: start/end" },
];

/** CSS named colours (lower-case, no `#`). */
const NAMED_COLOURS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
  "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod",
  "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
  "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey",
  "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray",
  "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green",
  "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory",
  "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
  "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
  "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
  "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
  "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise",
  "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
  "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
  "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue",
  "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna",
  "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow",
  "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

function normaliseHex(value: string): string {
  const hex = value.toLowerCase();
  const body = hex.slice(1);
  if (body.length === 3 || body.length === 4) {
    const expanded = [...body].map((ch) => ch + ch).join("");
    return `#${expanded}`;
  }
  return hex;
}

function normaliseColour(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("#")) return normaliseHex(trimmed);
  return trimmed.replace(/\s+/g, " ").replace(/,\s*/g, ", ");
}

/** Byte offset of every line start (index 0 plus after each `\n`). */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function locate(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo]! + 1 };
}

function snippetAt(source: string, starts: number[], index: number): string {
  const line = locate(starts, index).line;
  const start = starts[line - 1] ?? 0;
  let end = source.indexOf("\n", start);
  if (end === -1) end = source.length;
  return source.slice(start, end).trim().slice(0, 160);
}

interface RawHit {
  value: string;
  index: number;
  /** Optional replacement suggestion shown in the message. */
  hint?: string;
}

/** True when a Tailwind colour utility names a raw colour instead of a token. */
function isRawTailwindColour(suffix: string): boolean {
  const s = suffix.toLowerCase();
  if (s.startsWith("[")) {
    const inner = s.slice(1, -1);
    // `var(--primary)` and `color:var(--x)` are token references, not raw colours.
    if (inner.includes("var(")) return false;
    return /^(?:#|rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\b/.test(inner);
  }
  if (RAW_BASE_RE.test(s)) return true;
  if (SHADE_RE.test(s)) return true;
  if (STEM_RE.test(s)) return true;
  return NAMED_COLOURS.has(s);
}

/**
 * Literal colour tokens (hex/rgb/hsl/oklch) not inside a token declaration.
 *
 * `ranges` are the byte offsets covered by CSS custom-property declarations
 * (see {@link tokenDefinitionRanges}); the same array is reused by the palette
 * counter so the two views of the palette cannot drift apart.
 */
function literalColourHits(
  source: string,
  ranges: Array<[number, number]>,
): RawHit[] {
  const hits: RawHit[] = [];
  const patterns: Array<[RegExp, (m: string) => string]> = [
    [HEX_RE, (m) => normaliseHex(m)],
    [RGB_RE, (m) => m],
    [HSL_RE, (m) => m],
    [OKLCH_RE, (m) => m],
  ];
  for (const [re, normalise] of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const index = match.index;
      if (isTokenDefinitionIndex(ranges, index)) continue;
      hits.push({ value: normalise(match[0]), index });
    }
  }
  return hits;
}

/**
 * Offsets (in the whole source) covered by a CSS custom-property declaration.
 *
 * A token stylesheet often packs several declarations onto one line, inside a
 * `style` attribute, a JS object literal or a one-line `:root` block. The
 * exemption therefore has to cover every declaration on the line, not just the
 * first one, or a second `--x: oklch(...)` on the same line would be reported as
 * a raw colour while the first one is exempt.
 */
function tokenDefinitionRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  TOKEN_DEFINITION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_DEFINITION_RE.exec(source)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** True when `index` falls inside a CSS custom-property declaration. */
function isTokenDefinitionIndex(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Named colours used as CSS/inline-style declaration values. */
function namedColourHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  COLOUR_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COLOUR_DECL_RE.exec(source)) !== null) {
    const name = (match[2] ?? "").toLowerCase();
    if (NAMED_COLOURS.has(name)) {
      const index = match.index + match[0].lastIndexOf(match[2]!);
      hits.push({ value: name, index });
    }
  }
  return hits;
}

/** Raw Tailwind colour utilities (palette shades, literal bases, arbitrary). */
function tailwindColourHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  UTILITY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UTILITY_RE.exec(source)) !== null) {
    const utility = match[1] ?? "";
    const suffix = match[2] ?? "";
    if (!isRawTailwindColour(suffix)) continue;
    const index = match.index + (match[0].length - utility.length);
    hits.push({ value: utility.toLowerCase(), index });
  }
  return hits;
}

function distinctColourValues(source: string, ranges: Array<[number, number]>): Set<string> {
  const values = new Set<string>();
  for (const hit of literalColourHits(source, ranges)) values.add(normaliseColour(hit.value));
  for (const hit of namedColourHits(source)) values.add(hit.value);
  for (const hit of tailwindColourHits(source)) values.add(normaliseColour(hit.value));
  return values;
}

/**
 * Named font families a source actually chooses.
 *
 * Generic fallbacks (`system-ui`, `serif`, ...) and token references
 * (`var(--font-sans)`) are not design decisions, so they are excluded: only the
 * families the author deliberately picked count toward the two-family limit.
 */
function collectFontFamilies(source: string): Set<string> {
  const families = new Set<string>();
  FONT_FAMILY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FONT_FAMILY_RE.exec(source)) !== null) {
    for (const part of (match[1] ?? "").split(",")) {
      const token = part.trim().replace(/^['"]|['"]$/g, "").trim().toLowerCase();
      if (!token || token.startsWith("[") || token.includes("var(")) continue;
      if (GENERIC_FAMILIES.has(token)) continue;
      families.add(token);
    }
  }
  FONT_UTILITY_RE.lastIndex = 0;
  while ((match = FONT_UTILITY_RE.exec(source)) !== null) {
    const token = (match[1] ?? "").toLowerCase();
    if (!token || token.startsWith("[")) continue;
    families.add(token);
  }
  return families;
}

function arbitraryPxHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  ARBITRARY_PX_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ARBITRARY_PX_RE.exec(source)) !== null) {
    hits.push({ value: match[0], index: match.index });
  }
  INLINE_PX_RE.lastIndex = 0;
  while ((match = INLINE_PX_RE.exec(source)) !== null) {
    hits.push({ value: match[0], index: match.index });
  }
  return hits;
}

function emojiHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  EMOJI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMOJI_RE.exec(source)) !== null) {
    hits.push({ value: match[0], index: match.index });
  }
  return hits;
}

function missingAltHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  IMG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_RE.exec(source)) !== null) {
    if (!ALT_ATTR_RE.test(match[0])) hits.push({ value: match[0], index: match.index });
  }
  return hits;
}

function gradientHits(source: string): RawHit[] {
  const hits: RawHit[] = [];
  GRADIENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GRADIENT_RE.exec(source)) !== null) {
    hits.push({ value: match[0], index: match.index });
  }
  return hits;
}

/** Arabic content with no `dir="rtl"` on the root. */
function rtlDirectionHits(source: string): RawHit[] {
  if (!ARABIC_RE.test(source)) return [];
  if (RTL_DIR_RE.test(source)) return [];
  const index = source.search(ARABIC_RE);
  if (index < 0) return [];
  return [{ value: 'Arabic text without dir="rtl"', index }];
}

/** Physical directional properties under an RTL layout. */
function rtlLogicalPropertyHits(source: string): RawHit[] {
  const hasRtl = RTL_DIR_RE.test(source) || ARABIC_RE.test(source);
  if (!hasRtl) return [];
  const hits: RawHit[] = [];
  for (const { re, logical } of PHYSICAL_DIRECTIONAL) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      hits.push({ value: match[0].trim(), index: match.index, hint: logical });
    }
  }
  return hits;
}

function buildViolation(
  category: DesignViolationCategory,
  message: string,
  hit: RawHit,
  source: string,
  starts: number[],
): DesignViolation {
  const { line, column } = locate(starts, hit.index);
  return { category, message, line, column, snippet: snippetAt(source, starts, hit.index) };
}

function emptyCounts(): Record<DesignViolationCategory, number> {
  return {
    "raw-colour": 0,
    "too-many-colours": 0,
    "too-many-fonts": 0,
    "arbitrary-px": 0,
    "emoji-icon": 0,
    "missing-alt": 0,
    "gradient": 0,
    "rtl-logical-properties": 0,
    "rtl-direction": 0,
  };
}

/**
 * Lint one design source string against the UI Kit rules.
 *
 * Deterministic: the same source and options always produce the same result.
 */
export function lintDesignSource(source: string, options: DesignLintOptions = {}): DesignLintResult {
  const maxColours = options.maxColours ?? DEFAULT_MAX_COLOURS;
  const maxFonts = options.maxFonts ?? DEFAULT_MAX_FONTS;
  const ignoreTokenDefinitions = options.ignoreTokenDefinitions ?? true;
  const disabled = new Set(options.disabled ?? []);
  const allowed = new Set((options.allowedColours ?? []).map((c) => normaliseColour(c)));
  const starts = lineStarts(source);
  const violations: DesignViolation[] = [];
  // One declaration-range scan serves both the raw-colour rule and the palette
  // counter, so a token definition is never counted by one and ignored by the
  // other.
  const tokenRanges = ignoreTokenDefinitions ? tokenDefinitionRanges(source) : [];

  if (!disabled.has("raw-colour")) {
    const rawHits = [
      ...literalColourHits(source, tokenRanges),
      ...namedColourHits(source),
      ...tailwindColourHits(source),
    ];
    for (const hit of rawHits) {
      const value = normaliseColour(hit.value);
      if (allowed.has(value)) continue;
      violations.push(
        buildViolation(
          "raw-colour",
          `Raw colour "${value}" bypasses the semantic tokens; use a UI Kit token (e.g. bg-background, text-foreground, bg-primary).`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("too-many-colours")) {
    const colours = distinctColourValues(source, tokenRanges);
    if (colours.size > maxColours) {
      violations.push({
        category: "too-many-colours",
        message: `${colours.size} distinct colours exceed the ${maxColours}-colour palette limit.`,
        line: 1,
        column: 1,
        snippet: snippetAt(source, starts, 0),
      });
    }
  }

  if (!disabled.has("too-many-fonts")) {
    const fonts = collectFontFamilies(source);
    if (fonts.size > maxFonts) {
      violations.push({
        category: "too-many-fonts",
        message: `${fonts.size} distinct font families exceed the ${maxFonts}-family limit (${[...fonts].join(", ")}).`,
        line: 1,
        column: 1,
        snippet: snippetAt(source, starts, 0),
      });
    }
  }

  if (!disabled.has("arbitrary-px")) {
    for (const hit of arbitraryPxHits(source)) {
      violations.push(
        buildViolation(
          "arbitrary-px",
          `Arbitrary pixel value "${hit.value}" breaks the spacing scale; use a Tailwind spacing step or a token.`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("emoji-icon")) {
    for (const hit of emojiHits(source)) {
      violations.push(
        buildViolation(
          "emoji-icon",
          `Emoji "${hit.value}" is not an icon; use a single icon set at 16, 20 or 24 px.`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("missing-alt")) {
    for (const hit of missingAltHits(source)) {
      violations.push(
        buildViolation(
          "missing-alt",
          'Image is missing alt text; add a descriptive alt (or alt="" only when the image is purely decorative).',
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("gradient")) {
    for (const hit of gradientHits(source)) {
      violations.push(
        buildViolation(
          "gradient",
          `Decorative gradient "${hit.value.replace(/\s*\($/, "")}" is not allowed unless explicitly requested.`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("rtl-logical-properties")) {
    for (const hit of rtlLogicalPropertyHits(source)) {
      violations.push(
        buildViolation(
          "rtl-logical-properties",
          `Physical property "${hit.value}" ignores the RTL direction; use "${hit.hint}" so the layout mirrors correctly.`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  if (!disabled.has("rtl-direction")) {
    for (const hit of rtlDirectionHits(source)) {
      violations.push(
        buildViolation(
          "rtl-direction",
          `${hit.value}; set dir="rtl" (and lang="ar") on the root so Arabic content flows correctly.`,
          hit,
          source,
          starts,
        ),
      );
    }
  }

  const counts = emptyCounts();
  for (const violation of violations) counts[violation.category] += 1;
  const summary: DesignLintSummary = {
    colours: distinctColourValues(source, tokenRanges).size,
    fonts: collectFontFamilies(source).size,
    counts,
  };

  return { ok: violations.length === 0, source, violations, summary };
}

/** Render a lint result as a compact, human-readable report. */
export function formatDesignLintResult(result: DesignLintResult): string {
  if (result.ok) {
    return `design lint: OK (${result.summary.colours} colour(s), ${result.summary.fonts} font family(ies))`;
  }
  const lines = [
    `design lint: ${result.violations.length} violation(s) - ${result.summary.colours} colour(s), ${result.summary.fonts} font family(ies)`,
  ];
  for (const violation of result.violations) {
    lines.push(`  [${violation.category}] ${violation.line}:${violation.column} ${violation.message}`);
    if (violation.snippet) lines.push(`      ${violation.snippet}`);
  }
  return lines.join("\n");
}

/** Convenience predicate: true when the source is free of violations. */
export function isDesignLintClean(source: string, options: DesignLintOptions = {}): boolean {
  return lintDesignSource(source, options).ok;
}

/* -------------------------------------------------------------------------- */
/* Site-directory linter (eval harness contract)                              */
/* -------------------------------------------------------------------------- */

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




export function isRtl(locale: string): boolean {
  const tag = (locale || "").trim().toLowerCase();
  return /^(ar|he|fa|ur|ps|sd|ug|yi)\b/.test(tag);
}

/** Resolve the effective text direction for a fixture locale. */
export function resolveDirection(locale: string, explicit?: "ltr" | "rtl"): "ltr" | "rtl" {
  return explicit ?? (isRtl(locale) ? "rtl" : "ltr");
}

/**
 * Site-level lint issue rules, in the coarse vocabulary the eval harness and its
 * critique step understand. They map onto the finer-grained categories that
 * {@link lintDesignSource} reports, so the two views cannot drift apart.
 */
export type SiteRule =
  | "raw-color"
  | "too-many-colors"
  | "too-many-fonts"
  | "arbitrary-px"
  | "emoji-icon"
  | "gradient"
  | "missing-alt"
  | "rtl-dir"
  | "rtl-logical"
  | "rtl-direction";

/** Rules that block an RTL layout from being judged ready. */
const RTL_BLOCKING_RULES: ReadonlySet<SiteRule> = new Set(["rtl-dir", "rtl-logical"]);

/** Penalty per issue severity, mirroring the UI Kit rubric. */
const ERROR_PENALTY = 8;
const WARN_PENALTY = 3;

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

/**
 * Fold the fine-grained source violations into the coarse site rules the eval
 * harness consumes. A violation contributes to a rule only once per file, so a
 * repeated raw colour still reads as "raw colours used here" rather than as an
 * unbounded count.
 */
function toSiteIssue(rule: SiteRule, file: string, message: string): LintIssue {
  const severity: LintSeverity =
    rule === "raw-color" || rule === "missing-alt" || rule === "rtl-dir" || rule === "rtl-direction"
      ? "error"
      : "warn";
  return { rule, severity, file, message };
}

function lintScannedFile(file: ScannedFile, options: LintOptions, issues: LintIssue[]): void {
  const { relative, text } = file;
  const result = lintDesignSource(text, {
    // Token definition files are expected to hold literal palette values, so a
    // site that defines its tokens is not penalised for defining them.
    ignoreTokenDefinitions: true,
  });

  const seen = new Set<SiteRule>();
  const push = (rule: SiteRule, message: string): void => {
    if (seen.has(rule)) return;
    seen.add(rule);
    issues.push(toSiteIssue(rule, relative, message));
  };

  const counts = result.summary.counts;
  if (counts["raw-colour"] > 0) push("raw-color", `raw colour value(s) used instead of a semantic token (${counts["raw-colour"]})`);
  if (counts["too-many-colours"] > 0) push("too-many-colors", "palette limit exceeded");
  if (counts["too-many-fonts"] > 0) push("too-many-fonts", `more than two font families used (${result.summary.fonts})`);
  if (counts["arbitrary-px"] > 0) push("arbitrary-px", `arbitrary pixel value(s) used instead of the spacing scale (${counts["arbitrary-px"]})`);
  if (counts["emoji-icon"] > 0) push("emoji-icon", `emoji used as an icon or decoration (${counts["emoji-icon"]})`);
  if (counts["missing-alt"] > 0) push("missing-alt", `image(s) without alt text (${counts["missing-alt"]})`);
  if (counts["gradient"] > 0) push("gradient", `gradient used without an explicit opt-in (${counts["gradient"]})`);

  const rtlRequested = resolveDirection(options.locale ?? "", options.direction) === "rtl";
  if (!rtlRequested) return;

  // A root document that omits dir="rtl" is reported once for the site, not
  // once per Arabic file, so the issue list stays readable.
  const htmlFile = /\.html$/i.test(relative);
  const hasDirRtl = RTL_DIR_RE.test(text);
  if (htmlFile && !hasDirRtl) push("rtl-dir", 'missing dir="rtl" on the root element for an RTL locale');
  if (!hasDirRtl) push("rtl-direction", 'Arabic content without dir="rtl" on the root element');
  if (counts["rtl-logical-properties"] > 0) {
    push("rtl-logical", `physical directional property(ies) under an RTL layout (${counts["rtl-logical-properties"]})`);
  } else if (!LOGICAL_PROPERTY_RE.test(text)) {
    // No direction-agnostic property anywhere in the file: the layout cannot
    // mirror, so the site is not RTL-ready even if no physical property was
    // spotted yet.
    push("rtl-logical", "no logical properties (ms-/me-/ps-/pe-) found for an RTL locale");
  }
}

function computeScore(issues: LintIssue[]): number {
  let score = 100;
  for (const issue of issues) score -= issue.severity === "error" ? ERROR_PENALTY : WARN_PENALTY;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Lint a single in-memory source with the site rules. It exists so an editor
 * buffer and a directory on disk are scored by the same code path: a caller that
 * holds the source (an agent tool, a test) gets the same {@link LintResult} the
 * filesystem linter would produce for that file alone.
 */
export function lintSiteSource(source: string, options: LintOptions = {}): LintResult {
  const text = source ?? "";
  const issues: LintIssue[] = [];
  lintScannedFile({ relative: "inline", text }, options, issues);
  const rtlRequested = resolveDirection(options.locale ?? "", options.direction) === "rtl";
  const hasDirRtl = RTL_DIR_RE.test(text);
  const hasLogical = LOGICAL_PROPERTY_RE.test(text);
  return {
    score: computeScore(issues),
    issues,
    metrics: {
      files: 1,
      rawColors: issues.filter((issue) => issue.rule === "raw-color").length,
      arbitraryPx: issues.filter((issue) => issue.rule === "arbitrary-px").length,
      fontFamilies: collectFontFamilies(text).size,
      emoji: issues.filter((issue) => issue.rule === "emoji-icon").length,
      gradients: issues.filter((issue) => issue.rule === "gradient").length,
      missingAlt: issues.filter((issue) => issue.rule === "missing-alt").length,
      rtlReady: !rtlRequested || (hasDirRtl && hasLogical),
    },
  };
}

/**
 * Filesystem linter for a generated site directory.
 *
 * It delegates every rule to {@link lintDesignSource} and folds the result into
 * the compact {@link LintResult} the design eval harness scores, so the harness
 * and the `design_lint` agent tool always agree on whether a UI is compliant.
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
      for (const file of scanned) lintScannedFile(file, options, issues);

      const rtlRequested = resolveDirection(options.locale ?? "", options.direction) === "rtl";
      const hasDirRtl = scanned.some((f) => /\.html$/i.test(f.relative) && RTL_DIR_RE.test(f.text));
      const hasLogical = scanned.some((f) => LOGICAL_PROPERTY_RE.test(f.text));
      const rtlReady = !rtlRequested || (hasDirRtl && hasLogical);

      return {
        score: computeScore(issues),
        issues,
        metrics: {
          files: scanned.length,
          rawColors: issues.filter((i) => i.rule === "raw-color").length,
          arbitraryPx: issues.filter((i) => i.rule === "arbitrary-px").length,
          fontFamilies: new Set(scanned.flatMap((f) => [...collectFontFamilies(f.text)])).size,
          emoji: issues.filter((i) => i.rule === "emoji-icon").length,
          gradients: issues.filter((i) => i.rule === "gradient").length,
          missingAlt: issues.filter((i) => i.rule === "missing-alt").length,
          rtlReady,
        },
      };
    },
  };
}

/** Exposed for callers that need the blocking-rule set for an RTL layout. */
export function isRtlBlockingRule(rule: SiteRule): boolean {
  return RTL_BLOCKING_RULES.has(rule);
}
