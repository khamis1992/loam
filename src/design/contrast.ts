/**
 * WCAG contrast checking for the Loam UI Kit design tokens.
 *
 * The kit writes colours as oklch in `globals.css`, so every notation the
 * stylesheet can emit (hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`
 * and `oklab()`) is reduced here to sRGB before the WCAG 2.2
 * relative-luminance formula is applied. Each semantic token pair is then
 * checked against the AA/AAA text thresholds or the 3:1 threshold for
 * non-text UI, for both the light and the dark theme, and the failing pairs
 * are reported so a linter, an autofixer or the agent can repair them.
 *
 * Translucent colours are composited before the ratio is computed: the
 * foreground is laid over its background, and a translucent background is
 * flattened over opaque white first (pass a pre-composited colour when the
 * real backdrop is known). Arabic/RTL text uses the same thresholds.
 *
 * Contrast is direction-agnostic: `dir="rtl"` and the logical properties
 * (`ms-*`, `me-*`, `ps-*`) that RTL layouts use do not change a ratio, so
 * the same thresholds apply to Arabic text. Arabic glyphs are denser than
 * Latin ones, so a pair that only just clears AA is worth treating as
 * marginal even though WCAG does not define a separate threshold.
 */

export interface Rgb {
  /** Red channel, normalised to 0..1. */
  r: number;
  /** Green channel, normalised to 0..1. */
  g: number;
  /** Blue channel, normalised to 0..1. */
  b: number;
}

export interface ParsedColor extends Rgb {
  /** Alpha channel, normalised to 0..1. */
  alpha: number;
}

export type ContrastLevel = "aa-normal" | "aa-large" | "aaa-normal" | "aaa-large" | "ui";

export type ContrastGrade = "AAA" | "AA" | "AA Large" | "Fail";

/** Minimum ratio each level requires (WCAG 2.2 success criteria 1.4.3 / 1.4.6 / 1.4.11). */
export const CONTRAST_THRESHOLDS: Readonly<Record<ContrastLevel, number>> = {
  "aa-normal": 4.5,
  "aa-large": 3,
  "aaa-normal": 7,
  "aaa-large": 4.5,
  ui: 3,
};

export const CONTRAST_LEVELS: readonly ContrastLevel[] = [
  "aa-normal",
  "aa-large",
  "aaa-normal",
  "aaa-large",
  "ui",
];

export function requiredRatio(level: ContrastLevel): number {
  return CONTRAST_THRESHOLDS[level];
}

export function isContrastLevel(value: string): value is ContrastLevel {
  return (CONTRAST_LEVELS as readonly string[]).includes(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** An opaque white backdrop used to flatten a translucent background. */
const WHITE: Rgb = { r: 1, g: 1, b: 1 };

/** Normalise an `Rgb` or already-parsed colour into a `ParsedColor`. */
function toParsed(color: Rgb | ParsedColor): ParsedColor {
  return "alpha" in color ? color : { ...color, alpha: 1 };
}

/**
 * Blend a (possibly translucent) colour over an opaque backdrop. Alpha is
 * applied in sRGB space, which is how CSS compositing is specified.
 */
function compositeOver(color: ParsedColor, backdrop: Rgb): Rgb {
  const alpha = color.alpha;
  return {
    r: color.r * alpha + backdrop.r * (1 - alpha),
    g: color.g * alpha + backdrop.g * (1 - alpha),
    b: color.b * alpha + backdrop.b * (1 - alpha),
  };
}

/** Multiply an sRGB gamma-encoded channel into a linear-light channel. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Apply the sRGB gamma to a linear-light channel. */
function toSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const sat = clamp01(saturation);
  const lum = clamp01(lightness);
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const channel = (n: number) => {
    const value = lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return clamp01(value);
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

/** oklab -> linear sRGB, the Björn Ottosson transform. */
function oklabToSrgb(lightness: number, a: number, b: number): Rgb {
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: clamp01(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  return oklabToSrgb(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians));
}

const ANGLE_UNITS: Readonly<Record<string, number>> = {
  deg: 1,
  rad: 180 / Math.PI,
  grad: 0.9,
  turn: 360,
};

function parseAngle(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (trimmed === "none") return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  // A unitless number is degrees (CSS treats a bare hue as `deg`), but the
  // capture group is an empty string rather than undefined, so `??` is not
  // enough; an empty unit must fall back to degrees.
  const rawUnit = match[2] ?? "";
  const unit = rawUnit === "" ? "deg" : rawUnit;
  const factor = ANGLE_UNITS[unit];
  return factor === undefined ? null : value * factor;
}

/**
 * Parse a CSS number or percentage into a 0..`percentScale` value. `none`
 * resolves to zero, matching the CSS-wide keyword.
 */
function parseNumberOrPercent(token: string, percentScale: number): number | null {
  const trimmed = token.trim().toLowerCase();
  if (trimmed === "none") return 0;
  const isPercent = trimmed.endsWith("%");
  const numeric = isPercent ? trimmed.slice(0, -1) : trimmed;
  if (numeric === "") return null;
  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;
  return isPercent ? (value / 100) * percentScale : value;
}

function parseAlpha(token: string): number | null {
  const value = parseNumberOrPercent(token, 1);
  return value === null ? null : clamp01(value);
}

function parseHex(input: string): ParsedColor | null {
  const digits = input.slice(1);
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let alpha = 1;
  if (digits.length === 3 || digits.length === 4) {
    const expand = (index: number) => parseInt(`${digits[index] ?? ""}${digits[index] ?? ""}`, 16) / 255;
    r = expand(0);
    g = expand(1);
    b = expand(2);
    if (digits.length === 4) alpha = expand(3);
  } else if (digits.length === 6 || digits.length === 8) {
    r = parseInt(digits.slice(0, 2), 16) / 255;
    g = parseInt(digits.slice(2, 4), 16) / 255;
    b = parseInt(digits.slice(4, 6), 16) / 255;
    if (digits.length === 8) alpha = parseInt(digits.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  return { r, g, b, alpha };
}

/** Split `L C H / 0.5` into components plus an optional alpha token. */
function splitFunctionArgs(body: string): { components: string[]; alpha?: string } {
  const slash = body.indexOf("/");
  const head = slash === -1 ? body : body.slice(0, slash);
  const alpha = slash === -1 ? undefined : body.slice(slash + 1).trim();
  return { components: head.split(/[\s,]+/).filter((part) => part.length > 0), alpha };
}

function parseRgb(components: string[]): Rgb | null {
  if (components.length !== 3) return null;
  const r = parseNumberOrPercent(components[0] ?? "", 255);
  const g = parseNumberOrPercent(components[1] ?? "", 255);
  const b = parseNumberOrPercent(components[2] ?? "", 255);
  if (r === null || g === null || b === null) return null;
  return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255) };
}

function parseHsl(components: string[]): Rgb | null {
  if (components.length !== 3) return null;
  const hue = parseAngle(components[0] ?? "");
  const saturation = parseNumberOrPercent(components[1] ?? "", 1);
  const lightness = parseNumberOrPercent(components[2] ?? "", 1);
  if (hue === null || saturation === null || lightness === null) return null;
  return hslToRgb(hue, saturation, lightness);
}

function parseOklch(components: string[]): Rgb | null {
  if (components.length !== 3) return null;
  const lightness = parseNumberOrPercent(components[0] ?? "", 1);
  // A percentage chroma resolves against the 0.4 reference, per CSS Color 4.
  const chroma = parseNumberOrPercent(components[1] ?? "", 0.4);
  const hue = parseAngle(components[2] ?? "");
  if (lightness === null || chroma === null || hue === null) return null;
  return oklchToSrgb(lightness, chroma, hue);
}

function parseOklab(components: string[]): Rgb | null {
  if (components.length !== 3) return null;
  const lightness = parseNumberOrPercent(components[0] ?? "", 1);
  const a = parseNumberOrPercent(components[1] ?? "", 0.4);
  const b = parseNumberOrPercent(components[2] ?? "", 0.4);
  if (lightness === null || a === null || b === null) return null;
  return oklabToSrgb(lightness, a, b);
}

/**
 * Resolve the function arguments of `rgb()`/`rgba()`/`hsl()`/`hsla()` into
 * exactly three colour components plus an alpha. Both alpha notations are
 * accepted: the modern `rgb(1 2 3 / 0.5)` slash form and the legacy
 * `rgba(1,2,3,0.5)` comma form.
 */
function resolveColorArgs(
  name: string,
  body: string,
): { components: string[]; alpha: number } | null {
  const { components: rawComponents, alpha: slashAlpha } = splitFunctionArgs(body);
  const components = [...rawComponents];
  let alpha = 1;
  if (slashAlpha !== undefined) {
    const parsed = parseAlpha(slashAlpha);
    if (parsed === null) return null;
    alpha = parsed;
  }
  const commaAlpha = name === "rgb" || name === "rgba" || name === "hsl" || name === "hsla";
  if (commaAlpha && slashAlpha === undefined && components.length === 4) {
    const parsed = parseAlpha(components[3] ?? "");
    if (parsed === null) return null;
    alpha = parsed;
    components.pop();
  }
  return { components, alpha };
}

/** Parse any CSS colour notation the kit emits into linear-ready sRGB. */
export function parseColor(input: string): ParsedColor | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith("#")) return parseHex(lower);
  const match = /^([a-z]+)\((.*)\)$/s.exec(lower);
  if (!match) return null;
  const name = match[1] ?? "";
  const resolved = resolveColorArgs(name, match[2] ?? "");
  if (!resolved) return null;
  const { components, alpha } = resolved;
  let rgb: Rgb | null = null;
  if (name === "rgb" || name === "rgba") rgb = parseRgb(components);
  else if (name === "hsl" || name === "hsla") rgb = parseHsl(components);
  else if (name === "oklch") rgb = parseOklch(components);
  else if (name === "oklab") rgb = parseOklab(components);
  if (!rgb) return null;
  return { ...rgb, alpha };
}

/** WCAG 2.2 relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/**
 * Contrast ratio between two colours; `NaN` when either input cannot be
 * parsed. A translucent foreground is composited over the background, and a
 * translucent background is first flattened over an opaque white backdrop
 * before the foreground is laid over it. Callers that know the real backdrop
 * should pre-composite the background themselves.
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const first = typeof a === "string" ? parseColor(a) : toParsed(a);
  const second = typeof b === "string" ? parseColor(b) : toParsed(b);
  if (!first || !second) return Number.NaN;
  const background = second.alpha < 1 ? compositeOver(second, WHITE) : second;
  const foreground = first.alpha < 1 ? compositeOver(first, background) : first;
  const la = relativeLuminance(foreground);
  const lb = relativeLuminance(background);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The WCAG grade a ratio earns, independent of the target level. */
export function contrastGrade(ratio: number): ContrastGrade {
  if (!Number.isFinite(ratio)) return "Fail";
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA Large";
  return "Fail";
}

export interface ContrastResult {
  /** Ratio rounded to two decimals for stable output. */
  ratio: number;
  /** Ratio required by `level`. */
  required: number;
  level: ContrastLevel;
  /** True when the ratio meets `level`. */
  pass: boolean;
  grade: ContrastGrade;
}

function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/** Check one foreground/background pair against a level. */
export function checkPair(
  foreground: string | Rgb,
  background: string | Rgb,
  level: ContrastLevel = "aa-normal",
): ContrastResult {
  const ratio = contrastRatio(foreground, background);
  const required = requiredRatio(level);
  return {
    ratio: roundRatio(ratio),
    required,
    level,
    pass: Number.isFinite(ratio) && ratio >= required,
    grade: contrastGrade(ratio),
  };
}

/** A token map: token name -> CSS colour value. */
export interface TokenMap {
  [token: string]: string;
}

/** A semantic foreground/background token pair to verify. */
export interface TokenPairSpec {
  id: string;
  label: string;
  /** Foreground token name. */
  foreground: string;
  /** Background token name. */
  background: string;
  level: ContrastLevel;
}

/** Text pairs every Loam UI Kit theme must keep readable (AA 4.5:1). */
export const TEXT_TOKEN_PAIRS: readonly TokenPairSpec[] = [
  { id: "foreground-on-background", label: "Body text on the page background", foreground: "foreground", background: "background", level: "aa-normal" },
  { id: "foreground-on-card", label: "Body text on a card", foreground: "foreground", background: "card", level: "aa-normal" },
  { id: "foreground-on-secondary", label: "Body text on a secondary surface", foreground: "foreground", background: "secondary", level: "aa-normal" },
  { id: "foreground-on-muted", label: "Body text on a muted surface", foreground: "foreground", background: "muted", level: "aa-normal" },
  { id: "foreground-on-popover", label: "Body text in a popover", foreground: "foreground", background: "popover", level: "aa-normal" },
  { id: "card-foreground-on-card", label: "Card text on a card", foreground: "card-foreground", background: "card", level: "aa-normal" },
  { id: "popover-foreground-on-popover", label: "Popover text on a popover", foreground: "popover-foreground", background: "popover", level: "aa-normal" },
  { id: "primary-foreground-on-primary", label: "Primary button label", foreground: "primary-foreground", background: "primary", level: "aa-normal" },
  { id: "secondary-foreground-on-secondary", label: "Secondary button label", foreground: "secondary-foreground", background: "secondary", level: "aa-normal" },
  { id: "accent-foreground-on-accent", label: "Accent button label", foreground: "accent-foreground", background: "accent", level: "aa-normal" },
  { id: "destructive-foreground-on-destructive", label: "Destructive button label", foreground: "destructive-foreground", background: "destructive", level: "aa-normal" },
  { id: "muted-foreground-on-background", label: "Muted text on the page background", foreground: "muted-foreground", background: "background", level: "aa-normal" },
  { id: "muted-foreground-on-card", label: "Muted text on a card", foreground: "muted-foreground", background: "card", level: "aa-normal" },
  { id: "muted-foreground-on-secondary", label: "Muted text on a secondary surface", foreground: "muted-foreground", background: "secondary", level: "aa-normal" },
  { id: "muted-foreground-on-muted", label: "Muted text on a muted surface", foreground: "muted-foreground", background: "muted", level: "aa-normal" },
  { id: "sidebar-foreground-on-sidebar", label: "Sidebar text on the sidebar surface", foreground: "sidebar-foreground", background: "sidebar", level: "aa-normal" },
];

/** Non-text pairs (focus ring, border, chart stroke) at the 3:1 threshold. */
export const UI_TOKEN_PAIRS: readonly TokenPairSpec[] = [
  { id: "ring-on-background", label: "Focus ring against the page background", foreground: "ring", background: "background", level: "ui" },
  { id: "border-on-background", label: "Border against the page background", foreground: "border", background: "background", level: "ui" },
  { id: "input-on-card", label: "Input border against a card", foreground: "input", background: "card", level: "ui" },
  { id: "chart-on-card", label: "Chart stroke against a card", foreground: "chart-1", background: "card", level: "ui" },
];

/** Every pair checked by {@link checkThemeContrast}, text first. */
export const TOKEN_PAIRS: readonly TokenPairSpec[] = [...TEXT_TOKEN_PAIRS, ...UI_TOKEN_PAIRS];

export interface PairReport extends ContrastResult {
  id: string;
  label: string;
  mode: "light" | "dark";
  foregroundToken: string;
  backgroundToken: string;
  foreground: string;
  background: string;
  /** Present when a token is missing or a colour cannot be parsed. */
  note?: string;
}

export interface ThemeContrastReport {
  light: PairReport[];
  dark: PairReport[];
  /** Every pair that failed, in light-then-dark order. */
  failures: PairReport[];
  /** True when every checked pair met its level. */
  ok: boolean;
}

export interface ThemeContrastInput {
  light: TokenMap;
  /** Omit to check only the light theme. */
  dark?: TokenMap;
}

function checkTokenMap(tokens: TokenMap, mode: "light" | "dark"): PairReport[] {
  return TOKEN_PAIRS.map((spec): PairReport => {
    const foreground = tokens[spec.foreground];
    const background = tokens[spec.background];
    const missing =
      foreground === undefined ? spec.foreground : background === undefined ? spec.background : undefined;
    if (missing !== undefined) {
      return {
        ratio: Number.NaN,
        required: requiredRatio(spec.level),
        level: spec.level,
        pass: false,
        grade: "Fail",
        id: spec.id,
        label: spec.label,
        mode,
        foregroundToken: spec.foreground,
        backgroundToken: spec.background,
        foreground: foreground ?? "",
        background: background ?? "",
        note: `missing token: ${missing}`,
      };
    }
    const result = checkPair(foreground ?? "", background ?? "", spec.level);
    const note =
      Number.isFinite(result.ratio)
        ? undefined
        : `unparseable colour: ${foreground ?? ""} on ${background ?? ""}`;
    return {
      ...result,
      id: spec.id,
      label: spec.label,
      mode,
      foregroundToken: spec.foreground,
      backgroundToken: spec.background,
      foreground: foreground ?? "",
      background: background ?? "",
      ...(note === undefined ? {} : { note }),
    };
  });
}

/**
 * Verify every semantic pair in a light and (optionally) dark theme.
 *
 * A missing token or an unparseable colour is reported as a failure with a
 * `note`, so a linter can point at the exact token to fix.
 */
export function checkThemeContrast(theme: ThemeContrastInput): ThemeContrastReport {
  const light = checkTokenMap(theme.light, "light");
  const dark = theme.dark === undefined ? [] : checkTokenMap(theme.dark, "dark");
  const failures = [...light, ...dark].filter((report) => !report.pass);
  return { light, dark, failures, ok: failures.length === 0 };
}

/**
 * Pick the readable ink (black or white) for a background, preferring
 * `preferred` when it already meets the minimum ratio.
 */
export function readableInk(
  background: string,
  preferred = "#ffffff",
  minimum = 4.5,
): string {
  const ratio = contrastRatio(background, preferred);
  if (Number.isFinite(ratio) && ratio >= minimum) return preferred;
  return contrastRatio(background, "#000000") > contrastRatio(background, "#ffffff")
    ? "#000000"
    : "#ffffff";
}
