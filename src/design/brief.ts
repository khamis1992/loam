/**
 * design_brief — an LLM-authored visual design brief for build-phase UI work.
 *
 * Where `loam_design` (src/tools/designExplore.ts) derives deterministic,
 * hue-based directions, this module asks the model for one opinionated,
 * buildable visual system: a small semantic palette, at most two typefaces, a
 * layout plan, the imagery the page needs, and the accessibility rules the
 * implementation must honour. The model answer is parsed, validated against
 * `DESIGN_BRIEF_JSON_SCHEMA` and normalised; any transport or schema failure
 * degrades to a deterministic fallback so a build run never blocks on design.
 *
 * Everything here is offline-testable: the model is injected and tests supply
 * a fake client, so no real external API is ever called from a unit test.
 */

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { extractJson } from "../agent/planner.js";
import { chatWithFallback } from "../agent/model.js";
import { isCancelledError } from "../server/runControl.js";
import type { Usage } from "../agent/events.js";

/** Hard palette bounds: 1 primary, 2-3 neutrals, 1-2 accents. */
export const DESIGN_BRIEF_MIN_COLORS = 3;
export const DESIGN_BRIEF_MAX_COLORS = 5;
/** At most two families: one for body, optionally one for display. */
export const DESIGN_BRIEF_MAX_FONTS = 2;

const HEX_RE = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const ARABIC_RE = /[\u0600-\u06ff]/;

export interface DesignBriefColor {
  /** Semantic role: background, surface, foreground, primary, neutral, accent, border. */
  role: string;
  /** `#rrggbb` (or shorthand `#rgb`). */
  hex: string;
  /** Where the colour is applied. */
  usage: string;
}

export interface DesignBriefFont {
  /** "sans" | "heading" | "mono". */
  role: string;
  /** Font family name. */
  family: string;
  /** Local/system fallback stack. */
  fallback: string;
}

export interface DesignBriefImage {
  /** "hero" | "icon" | "illustration". */
  role: string;
  description: string;
  placement: string;
  /** Alt text; required for every image. */
  alt: string;
}

export interface DesignBrief {
  mood: string;
  summary: string;
  palette: DesignBriefColor[];
  fonts: DesignBriefFont[];
  layout: string;
  layoutPrinciples: string[];
  imageNeeds: DesignBriefImage[];
  accessibility: string[];
  rtl: boolean;
  /** CSS custom-property name -> hex, ready for globals.css. */
  tokens: Record<string, string>;
}

/** JSON Schema handed to the model and used to validate its answer. */
export const DESIGN_BRIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mood", "summary", "palette", "fonts", "layout", "layoutPrinciples", "imageNeeds", "accessibility", "rtl", "tokens"],
  properties: {
    mood: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    palette: {
      type: "array",
      minItems: DESIGN_BRIEF_MIN_COLORS,
      maxItems: DESIGN_BRIEF_MAX_COLORS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "hex", "usage"],
        properties: {
          role: { type: "string", minLength: 1 },
          hex: { type: "string", pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" },
          usage: { type: "string", minLength: 1 },
        },
      },
    },
    fonts: {
      type: "array",
      minItems: 1,
      maxItems: DESIGN_BRIEF_MAX_FONTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "family", "fallback"],
        properties: {
          role: { type: "string", minLength: 1 },
          family: { type: "string", minLength: 1 },
          fallback: { type: "string", minLength: 1 },
        },
      },
    },
    layout: { type: "string", minLength: 1 },
    layoutPrinciples: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    imageNeeds: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "description", "placement", "alt"],
        properties: {
          role: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          placement: { type: "string", minLength: 1 },
          alt: { type: "string", minLength: 1 },
        },
      },
    },
    accessibility: { type: "array", items: { type: "string", minLength: 1 } },
    rtl: { type: "boolean" },
    tokens: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

/** The full system prompt. Written in Loam's own voice; never copied from v0. */
export const DESIGN_BRIEF_SYSTEM_PROMPT = [
  "You are a senior product designer producing one complete visual design brief for a web interface.",
  "A brief turns a short product description into an opinionated, buildable visual system: a small semantic colour set, at most two typefaces, a layout plan, the imagery the page needs, and the accessibility rules the implementation must honour.",
  "",
  "Work only from the product brief you are given. Infer the audience, the tone and the job the interface does, then commit to ONE coherent direction. Do not hedge with a menu of unrelated options and do not describe several alternative styles.",
  "",
  "Hard rules:",
  `- Colour: between ${DESIGN_BRIEF_MIN_COLORS} and ${DESIGN_BRIEF_MAX_COLORS} named colours total, never more. Give each a semantic role (background, surface, foreground, primary, neutral, accent, border), a hex value and where it is used. Aim for one primary, two to three neutrals and one to two accents.`,
  `- Type: at most ${DESIGN_BRIEF_MAX_FONTS} font families (one for body, optionally one for display). Name each family and a local fallback stack. Body text is at least 14px with a line-height between 1.5 and 1.6.`,
  "- Layout: mobile-first. Prefer flex for one-dimensional flow, grid for two-dimensional arrangements, and absolute positioning only for overlays. Use the spacing scale and gap, keep a maximum content width, and give sections consistent vertical padding.",
  "- Colour usage: reference semantic tokens, never raw palette classes. Do not use gradients unless the brief explicitly asks for one; if you do, use at most three analogous stops. Every background you set must come with a matching text colour.",
  "- Imagery: list the real images the page needs with the alt text for each. Never propose placeholders, decorative blobs, gradient circles or hand-drawn illustrations. Icons come from a single set at 16, 20 or 24px; never use emoji as icons.",
  "- Accessibility: every text/background pair must meet WCAG AA (4.5:1 for normal text, 3:1 for large text and UI boundaries). Use semantic landmarks, labelled inputs and a visible focus ring.",
  '- RTL/Arabic: when the content language is Arabic or the direction is rtl, set rtl=true, choose Arabic-capable typefaces (for example IBM Plex Sans Arabic or Noto Kufi Arabic), set dir="rtl" on the document, and use logical properties (ms-*, me-*, ps-*, pe-*) instead of physical left/right.',
  "",
  "Output: reply with a single JSON object and nothing else. No markdown fences, no commentary before or after.",
  'Schema: {"mood": string, "summary": string, "palette": [{"role": string, "hex": string, "usage": string}], "fonts": [{"role": string, "family": string, "fallback": string}], "layout": string, "layoutPrinciples": string[], "imageNeeds": [{"role": string, "description": string, "placement": string, "alt": string}], "accessibility": string[], "rtl": boolean, "tokens": object}',
  'The "tokens" object maps CSS custom-property names (for example "--background", "--primary", "--border") to hex values drawn from the palette, so the implementation can write them straight into globals.css.',
  `Before you answer, self-check: ${DESIGN_BRIEF_MIN_COLORS}-${DESIGN_BRIEF_MAX_COLORS} palette entries, at most ${DESIGN_BRIEF_MAX_FONTS} fonts, every hex is #rrggbb, every image has alt text, and every token value is one of the palette hex values.`,
].join("\n");

export type DesignBriefValidation =
  | { ok: true; brief: DesignBrief }
  | { ok: false; errors: string[] };

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, durationMs: 0 };
}

/** Normalise a 3- or 6-digit hex to lowercase `#rrggbb`. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!HEX_RE.test(v)) return null;
  if (v.length === 4) {
    const r = v[1]!;
    const g = v[2]!;
    const b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return v;
}

/** Map a semantic role to a CSS custom-property name. */
export function tokenNameFor(role: string): string {
  const slug = role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `--${slug.length > 0 ? slug : "color"}`;
}

/** Derive the tokens map from the palette so it can never drift from it. */
export function buildTokens(palette: ReadonlyArray<DesignBriefColor>): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const color of palette) tokens[tokenNameFor(color.role)] = color.hex;
  return tokens;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Validate and normalise a parsed model answer. Coerces harmless formatting
 * (shorthand hex, surrounding whitespace) and reports every structural
 * violation — palette size, font count, missing alt text, malformed hex — so
 * the caller can ask the model to repair or fall back deterministically.
 */
export function normalizeDesignBrief(raw: unknown, seedBrief: string, rtl: boolean): DesignBriefValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["design brief must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  const mood = nonEmptyString(obj["mood"]);
  const summary = nonEmptyString(obj["summary"]);
  const layout = nonEmptyString(obj["layout"]);
  if (!mood) errors.push("mood must be a non-empty string");
  if (!summary) errors.push("summary must be a non-empty string");
  if (!layout) errors.push("layout must be a non-empty string");

  const palette: DesignBriefColor[] = [];
  const rawPalette = Array.isArray(obj["palette"]) ? obj["palette"] : [];
  if (rawPalette.length < DESIGN_BRIEF_MIN_COLORS || rawPalette.length > DESIGN_BRIEF_MAX_COLORS) {
    errors.push(`palette must contain ${DESIGN_BRIEF_MIN_COLORS}-${DESIGN_BRIEF_MAX_COLORS} colours, got ${rawPalette.length}`);
  }
  for (const entry of rawPalette) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each palette entry must be an object");
      continue;
    }
    const item = entry as Record<string, unknown>;
    const role = nonEmptyString(item["role"]);
    const hex = normalizeHex(item["hex"]);
    const usage = nonEmptyString(item["usage"]);
    if (!role) errors.push("each palette entry needs a non-empty role");
    if (!hex) errors.push(`palette hex must be #rrggbb (role ${role ?? "?"})`);
    if (!usage) errors.push(`palette entry ${role ?? "?"} needs a non-empty usage`);
    if (role && hex && usage) palette.push({ role, hex, usage });
  }

  const fonts: DesignBriefFont[] = [];
  const rawFonts = Array.isArray(obj["fonts"]) ? obj["fonts"] : [];
  if (rawFonts.length < 1 || rawFonts.length > DESIGN_BRIEF_MAX_FONTS) {
    errors.push(`fonts must contain 1-${DESIGN_BRIEF_MAX_FONTS} families, got ${rawFonts.length}`);
  }
  for (const entry of rawFonts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each font entry must be an object");
      continue;
    }
    const item = entry as Record<string, unknown>;
    const role = nonEmptyString(item["role"]);
    const family = nonEmptyString(item["family"]);
    const fallback = nonEmptyString(item["fallback"]);
    if (!role) errors.push("each font entry needs a non-empty role");
    if (!family) errors.push("each font entry needs a non-empty family");
    if (!fallback) errors.push(`font ${family ?? "?"} needs a non-empty fallback`);
    if (role && family && fallback) fonts.push({ role, family, fallback });
  }

  const layoutPrinciples = stringList(obj["layoutPrinciples"]);
  if (layoutPrinciples.length === 0) errors.push("layoutPrinciples must list at least one principle");

  const imageNeeds: DesignBriefImage[] = [];
  const rawImages = Array.isArray(obj["imageNeeds"]) ? obj["imageNeeds"] : [];
  for (const entry of rawImages) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each imageNeeds entry must be an object");
      continue;
    }
    const item = entry as Record<string, unknown>;
    const role = nonEmptyString(item["role"]);
    const description = nonEmptyString(item["description"]);
    const placement = nonEmptyString(item["placement"]);
    const alt = nonEmptyString(item["alt"]);
    if (!role || !description || !placement || !alt) {
      errors.push("every imageNeeds entry needs role, description, placement and alt text");
      continue;
    }
    imageNeeds.push({ role, description, placement, alt });
  }

  const accessibility = stringList(obj["accessibility"]);

  if (errors.length > 0) return { ok: false, errors };

  const resolvedRtl = typeof obj["rtl"] === "boolean" ? obj["rtl"] : rtl;
  return {
    ok: true,
    brief: {
      mood: mood!,
      summary: summary!,
      palette,
      fonts,
      layout: layout!,
      layoutPrinciples,
      imageNeeds,
      accessibility,
      rtl: resolvedRtl,
      tokens: buildTokens(palette),
    },
  };
}

/** True when the brief or language calls for right-to-left typography. */
export function isRtlBrief(brief: string, language?: string, direction?: "ltr" | "rtl"): boolean {
  if (direction === "rtl") return true;
  if (direction === "ltr") return false;
  const lang = (language ?? "").trim().toLowerCase();
  if (lang.startsWith("ar")) return true;
  return ARABIC_RE.test(brief);
}

interface FallbackStyle {
  id: string;
  mood: string;
  summary: string;
  palette: DesignBriefColor[];
  fonts: DesignBriefFont[];
  layout: string;
  layoutPrinciples: string[];
  accessibility: string[];
}

const FALLBACK_STYLES: FallbackStyle[] = [
  {
    id: "quiet-light",
    mood: "Calm, light-first and quietly confident.",
    summary: "A generous light theme where whitespace and typography carry the identity and a single green accent marks every action.",
    palette: [
      { role: "background", hex: "#fbfbf8", usage: "Page background." },
      { role: "surface", hex: "#f0f1ea", usage: "Cards, inputs and raised panels." },
      { role: "foreground", hex: "#1c1d19", usage: "Body text and headings." },
      { role: "primary", hex: "#2f6f5e", usage: "Primary buttons, links and active states." },
      { role: "border", hex: "#dcdcd2", usage: "Hairlines and input borders." },
    ],
    fonts: [
      { role: "sans", family: "Inter", fallback: "system-ui, -apple-system, Segoe UI, sans-serif" },
      { role: "heading", family: "Fraunces", fallback: "Georgia, Times New Roman, serif" },
    ],
    layout: "Single-column narrative with a centered hero above the fold, a narrow 68ch reading measure and feature rows in a responsive grid.",
    layoutPrinciples: [
      "Mobile-first single column that widens into a 12-column grid at 1024px.",
      "Flex for vertical flow, grid only for the feature and card rows.",
      "24px section padding on mobile, 48px on desktop.",
    ],
    accessibility: [
      "Body text 16px with a 1.6 line-height.",
      "Foreground on background and primary-foreground on primary both exceed 4.5:1 contrast.",
      "Every interactive element shows a visible 2px focus ring.",
    ],
  },
  {
    id: "dark-foundry",
    mood: "Technical, dense and high-contrast.",
    summary: "A near-black dark theme built on one saturated cyan accent and a precise grid; type stays luminous against the dark surfaces.",
    palette: [
      { role: "background", hex: "#0b0d10", usage: "Page background." },
      { role: "surface", hex: "#14181d", usage: "Cards and panels." },
      { role: "foreground", hex: "#eef2f6", usage: "Body text and headings." },
      { role: "primary", hex: "#22d3ee", usage: "Primary actions and highlights." },
      { role: "border", hex: "#262c34", usage: "Hairlines and input borders." },
    ],
    fonts: [
      { role: "sans", family: "IBM Plex Sans", fallback: "system-ui, -apple-system, Segoe UI, sans-serif" },
      { role: "mono", family: "IBM Plex Mono", fallback: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    ],
    layout: "Edge-to-edge hero over a 12-column grid, with dense data tables and a left rail for navigation on wide screens.",
    layoutPrinciples: [
      "Mobile-first single column; the left rail appears only at 1280px and above.",
      "Grid for the dashboard tiles, flex for the header and toolbars.",
      "Consistent 16px gutter and 32px section padding.",
    ],
    accessibility: [
      "Body text 15px with a 1.55 line-height.",
      "Cyan primary is used for large text and UI boundaries only, never for small body copy.",
      "Dark surfaces never drop below 4.5:1 against their foreground text.",
    ],
  },
  {
    id: "warm-editorial",
    mood: "Crafted, warm and editorial.",
    summary: "A cream paper background, an earthy terracotta accent and a serif display voice give the page a magazine-like rhythm.",
    palette: [
      { role: "background", hex: "#f7f1e6", usage: "Page background." },
      { role: "surface", hex: "#efe6d4", usage: "Cards and pull quotes." },
      { role: "foreground", hex: "#2a2118", usage: "Body text and headings." },
      { role: "primary", hex: "#b4532a", usage: "Links, rules and primary actions." },
      { role: "accent", hex: "#6b7f4e", usage: "Secondary highlights and tags." },
    ],
    fonts: [
      { role: "heading", family: "Fraunces", fallback: "Georgia, Times New Roman, serif" },
      { role: "sans", family: "Source Sans 3", fallback: "system-ui, -apple-system, Segoe UI, sans-serif" },
    ],
    layout: "An editorial two-column spread with a spanning hero headline, a thin rule under the masthead and staggered article cards below.",
    layoutPrinciples: [
      "Mobile-first single column that becomes a 12-column spread at 900px.",
      "Flex for the article list, grid for the hero and the feature band.",
      "20px section padding on mobile, 40px on desktop.",
    ],
    accessibility: [
      "Body text 16px with a 1.6 line-height.",
      "Terracotta primary meets 4.5:1 on the cream background for normal text.",
      "Links are underlined in addition to colour so they survive greyscale.",
    ],
  },
  {
    id: "cool-product",
    mood: "Modern, friendly and product-focused.",
    summary: "A soft violet accent over neutral slate surfaces keeps the interface approachable while charts and tables stay precise.",
    palette: [
      { role: "background", hex: "#f6f7fb", usage: "Page background." },
      { role: "surface", hex: "#ffffff", usage: "Cards and modals." },
      { role: "foreground", hex: "#1f2430", usage: "Body text and headings." },
      { role: "primary", hex: "#5b5bd6", usage: "Primary buttons, links and active nav." },
      { role: "accent", hex: "#0ea5a4", usage: "Success states and positive chart series." },
    ],
    fonts: [
      { role: "sans", family: "Inter", fallback: "system-ui, -apple-system, Segoe UI, sans-serif" },
      { role: "mono", family: "JetBrains Mono", fallback: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    ],
    layout: "A centered product shell: compact top nav, a hero band, then a responsive card grid that reflows from one to three columns.",
    layoutPrinciples: [
      "Mobile-first single column with a sticky top nav.",
      "Grid for the card and pricing rows, flex for the nav and hero.",
      "24px section padding with a 1200px maximum content width.",
    ],
    accessibility: [
      "Body text 15px with a 1.55 line-height.",
      "Violet primary and teal accent are paired with white text to keep 4.5:1 contrast.",
      "Form inputs have visible labels and a 2px focus ring.",
    ],
  },
];

const RTL_FONTS: DesignBriefFont[] = [
  { role: "sans", family: "IBM Plex Sans Arabic", fallback: "Noto Naskh Arabic, system-ui, sans-serif" },
  { role: "heading", family: "Noto Kufi Arabic", fallback: "IBM Plex Sans Arabic, system-ui, sans-serif" },
];

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic, always-valid brief used when the model is unavailable or its
 * answer cannot be validated. Curated so it satisfies the schema (3-5 colours,
 * at most 2 fonts) without any model call.
 */
export function fallbackDesignBrief(brief: string, rtl: boolean): DesignBrief {
  const style = FALLBACK_STYLES[hash32(brief.trim().toLowerCase()) % FALLBACK_STYLES.length]!;
  const fonts = rtl ? RTL_FONTS : style.fonts;
  const layout = rtl ? `${style.layout} Direction is right-to-left: dir="rtl" with logical properties (ms-*, me-*, ps-*, pe-*).` : style.layout;
  const accessibility = rtl
    ? [...style.accessibility, "Arabic typefaces are used for both body and display text.", "dir=\"rtl\" is set on the document and logical properties replace left/right margins."]
    : style.accessibility;
  return {
    mood: style.mood,
    summary: style.summary,
    palette: style.palette.map((color) => ({ ...color })),
    fonts: fonts.map((font) => ({ ...font })),
    layout,
    layoutPrinciples: [...style.layoutPrinciples],
    imageNeeds: [
      {
        role: "hero",
        description: `A single real hero photograph that illustrates ${brief.trim()}.`,
        placement: "Above the fold, spanning the content width.",
        alt: `Hero image illustrating ${brief.trim()}`,
      },
    ],
    accessibility,
    rtl,
    tokens: buildTokens(style.palette),
  };
}

export interface GenerateDesignBriefOptions {
  cfg: Config;
  ollama?: OllamaClient;
  brief: string;
  language?: string;
  direction?: "ltr" | "rtl";
  audience?: string;
  mood?: string;
  constraints?: string;
  signal?: AbortSignal;
  /** Preferred model; "" = the configured model. */
  model?: string;
  /** Model attempts before the deterministic fallback (default 2). */
  maxAttempts?: number;
}

export interface DesignBriefResult {
  brief: DesignBrief;
  source: "model" | "fallback";
  model: string;
  usage: Usage;
  warnings: string[];
}

function buildBriefUserPrompt(options: GenerateDesignBriefOptions, rtl: boolean): string {
  const brief = options.brief.trim();
  const lines = [
    `PRODUCT BRIEF: ${brief}`,
    `CONTENT DIRECTION: ${rtl ? "rtl (Arabic)" : "ltr"}`,
  ];
  if (options.language) lines.push(`CONTENT LANGUAGE: ${options.language.trim()}`);
  if (options.audience) lines.push(`AUDIENCE: ${options.audience.trim()}`);
  if (options.mood) lines.push(`DESIRED MOOD: ${options.mood.trim()}`);
  if (options.constraints) lines.push(`CONSTRAINTS: ${options.constraints.trim()}`);
  lines.push("", "Return the JSON design brief now.");
  return lines.join("\n");
}

function repairUserPrompt(base: string, errors: string[]): string {
  return [
    base,
    "",
    "Your previous answer was rejected for these reasons:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return a corrected JSON object only. Fix every listed issue.",
  ].join("\n");
}

/**
 * Produce a validated design brief. Calls the injected model, validates the
 * answer against the schema, retries once with the validation errors, and
 * degrades to the deterministic fallback on any transport or schema failure.
 * Never throws for a model problem; only cancellation propagates.
 */
export async function generateDesignBrief(options: GenerateDesignBriefOptions): Promise<DesignBriefResult> {
  const brief = options.brief.trim();
  if (brief.length < 4) throw new Error("brief must be at least 4 characters");

  const rtl = isRtlBrief(brief, options.language, options.direction);
  const warnings: string[] = [];
  const model = options.model ?? options.cfg.model;

  if (!options.ollama) {
    return {
      brief: fallbackDesignBrief(brief, rtl),
      source: "fallback",
      model,
      usage: zeroUsage(),
      warnings: ["no model client was provided; used the deterministic fallback"],
    };
  }

  const basePrompt = buildBriefUserPrompt(options, rtl);
  const attempts = Math.max(1, options.maxAttempts ?? 2);
  let usage = zeroUsage();
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await chatWithFallback({
        cfg: options.cfg,
        ollama: options.ollama!,
        messages: [
          { role: "system", content: DESIGN_BRIEF_SYSTEM_PROMPT },
          { role: "user", content: attempt === 1 ? basePrompt : repairUserPrompt(basePrompt, lastErrors) },
        ],
        temperature: 0.2,
        model: options.model,
        signal: options.signal,
      });
      usage = {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: result.usage.durationMs,
      };
      const raw = extractJson(result.content);
      if (raw === null) {
        lastErrors = ["model output was not a JSON object"];
        continue;
      }
      const normalized = normalizeDesignBrief(raw, brief, rtl);
      if (normalized.ok) return { brief: normalized.brief, source: "model", model: result.model, usage, warnings };
      lastErrors = normalized.errors;
    } catch (error) {
      if (options.signal?.aborted || isCancelledError(error)) throw error;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      break;
    }
  }

  return {
    brief: fallbackDesignBrief(brief, rtl),
    source: "fallback",
    model,
    usage,
    warnings: [...warnings, ...lastErrors.map((error) => `model brief unavailable (${error}); used the deterministic fallback`)],
  };
}

/** Persist the brief's token map next to the app source. Returns the workspace-relative path. */
export async function writeDesignTokens(
  workspace: string,
  relPath: string,
  brief: DesignBrief,
  generatedBy = "design_brief",
): Promise<string> {
  const target = path.resolve(workspace, relPath.trim() || "design-tokens.json");
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const payload = {
    generatedBy,
    rtl: brief.rtl,
    mood: brief.mood,
    tokens: brief.tokens,
    palette: brief.palette,
    fonts: brief.fonts,
  };
  await fs.promises.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  const relative = path.relative(workspace, target);
  return relative.length > 0 ? relative : path.basename(target);
}
