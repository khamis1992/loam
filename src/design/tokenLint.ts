/**
 * Loam UI Kit token linter.
 *
 * Static, dependency-free checks for the design rules the Loam UI Kit asks
 * generated web UIs to follow: semantic colour tokens instead of raw colours,
 * a bounded palette, a bounded number of font families, the Tailwind spacing
 * scale instead of arbitrary pixel values, real icons instead of emoji, alt
 * text on images, no decorative gradients, and RTL-correct logical properties
 * for right-to-left layouts.
 *
 * The linter never executes the input and never reads the filesystem: callers
 * hand it a source string (a TSX/HTML/CSS/JS file, or a whole concatenated
 * bundle) and get back a deterministic list of violations with line/column
 * coordinates. The companion `design_lint` agent tool wraps it so the model can
 * lint a task workspace without a shell round-trip; the pipeline can also call
 * this module directly before/after `design_autofix`.
 *
 * Rules implemented here:
 *  - raw-colour            literal colours (hex/rgb/hsl/oklch/named/Tailwind
 *                          colour utilities) where a semantic token is expected
 *  - too-many-colours      more than `maxColours` distinct colours in one source
 *  - too-many-fonts        more than `maxFonts` distinct font families in one source
 *  - arbitrary-px          arbitrary `[Npx]` Tailwind values and inline px on layout
 *  - emoji-icon            emoji used as UI affordances
 *  - missing-alt           `<img>` without an `alt` attribute
 *  - gradient              decorative gradient backgrounds
 *  - rtl-logical-properties physical directional properties under an RTL layout
 *  - rtl-direction         Arabic content without `dir="rtl"`
 *
 * Written in Loam's own words; the thresholds mirror the UI Kit spec, not any
 * third-party prompt text.
 */

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
/** Inline-style numeric px on layout/typography properties. */
const INLINE_PX_RE =
  /(?:fontSize|width|height|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginTop|marginRight|marginBottom|marginLeft|gap|top|left|right|bottom|borderRadius)\s*:\s*['"]?(\d+(?:\.\d+)?)px\b/gi;

const FONT_FAMILY_RE = /(?:font-family|fontFamily)\s*:\s*["']?([^;}"'`]+)["']?/gi;
const FONT_UTILITY_RE = /(?:^|[\s"'`])font-([a-z0-9-]+)/gi;

const IMG_RE = /<img\b[^>]*>/gi;
const ALT_ATTR_RE = /\balt\s*=/i;

const GRADIENT_RE =
  /(?:bg-gradient-to-[a-z]+|bg-linear-\d+deg|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\()/gi;

const EMOJI_RE =
  /\p{Emoji_Presentation}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})*(?:\u200D\p{Emoji_Presentation}(?:\uFE0F|\u{1F3FB}-\u{1F3FF})*)*/gu;

/** CSS custom-property definition line, e.g. `--primary: oklch(...)`. */
const TOKEN_DEFINITION_LINE_RE = /^\s*--[\w-]+\s*:/;

/** A declared right-to-left direction, in JSX, HTML or inline style form. */
const RTL_DIR_RE = /(?:dir\s*=\s*["']?rtl["']?|dir\s*:\s*["']rtl["'])/i;

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

/** Literal colour tokens (hex/rgb/hsl/oklch) not on token-definition lines. */
function literalColourHits(source: string, ignoreTokenDefinitions: boolean): RawHit[] {
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
      if (ignoreTokenDefinitions && isTokenDefinitionLine(source, index)) continue;
      hits.push({ value: normalise(match[0]), index });
    }
  }
  return hits;
}

function isTokenDefinitionLine(source: string, index: number): boolean {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", start);
  const line = source.slice(start, end === -1 ? source.length : end);
  return TOKEN_DEFINITION_LINE_RE.test(line);
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

function distinctColourValues(source: string, ignoreTokenDefinitions: boolean): Set<string> {
  const values = new Set<string>();
  for (const hit of literalColourHits(source, ignoreTokenDefinitions)) values.add(normaliseColour(hit.value));
  for (const hit of namedColourHits(source)) values.add(hit.value);
  for (const hit of tailwindColourHits(source)) values.add(normaliseColour(hit.value));
  return values;
}

function firstFamily(stack: string): string | undefined {
  for (const part of stack.split(",")) {
    const token = part.trim().replace(/^['"]|['"]$/g, "").trim().toLowerCase();
    if (!token) continue;
    return token;
  }
  return undefined;
}

function collectFontFamilies(source: string): Set<string> {
  const families = new Set<string>();
  FONT_FAMILY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FONT_FAMILY_RE.exec(source)) !== null) {
    const family = firstFamily(match[1] ?? "");
    if (family) families.add(family);
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

  if (!disabled.has("raw-colour")) {
    const rawHits = [
      ...literalColourHits(source, ignoreTokenDefinitions),
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
    const colours = distinctColourValues(source, ignoreTokenDefinitions);
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
    colours: distinctColourValues(source, ignoreTokenDefinitions).size,
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
