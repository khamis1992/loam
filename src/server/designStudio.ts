/**
 * Design Studio core (clean-room, behavioral spec only).
 *
 * Original TypeScript implementation — no ArtCraft code, assets, or names.
 * Model: brand kits (colors/fonts/logo refs), a small set of JSON layout
 * templates, a deterministic template-fill step, and a generate step that
 * renders a brand-consistent SVG and optionally calls an injected image
 * generator (the image tool). Persistence follows the entity-store pattern
 * used by scratchpad/secretsVault (kind-scoped sqlite entities) plus files
 * under DATA_DIR/design/.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { allEntities, getEntity, putEntity, removeEntity } from "./sqliteStore.js";

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

export interface BrandFonts {
  heading: string;
  body: string;
}

export interface BrandKit {
  id: string;
  name: string;
  colors: BrandColors;
  fonts: BrandFonts;
  logoRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export type SlotType = "title" | "subtitle" | "badge" | "shape" | "logo" | "image";

export interface TemplateSlot {
  id: string;
  type: SlotType;
  /** Which brand color binds to this slot. */
  colorRole: keyof BrandColors | "none";
  /** Which brand font binds to this slot (text slots only). */
  fontRole: keyof BrandFonts | "none";
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center" | "right";
}

export interface DesignTemplate {
  id: string;
  name: string;
  description: string;
  canvas: { width: number; height: number };
  slots: TemplateSlot[];
}

export interface ParsedBrief {
  title: string;
  subtitle: string;
  tags: string[];
}

export interface FilledSlot {
  id: string;
  type: SlotType;
  color: string;
  font: string;
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center" | "right";
  text?: string;
  src?: string;
}

export interface DesignSpec {
  templateId: string;
  canvas: { width: number; height: number };
  background: string;
  slots: FilledSlot[];
}

export interface DesignRecord {
  id: string;
  brief: string;
  templateId: string;
  brandKitId: string;
  brandName: string;
  specFile: string;
  svgFile: string;
  imageFile?: string;
  generator: "builtin-svg" | "injected-image-tool";
  createdAt: string;
}

/** Optional injected image generator (the image tool). Implementations may
 *  return raster PNG bytes and/or replace the builtin SVG render. */
export interface ImageGenRequest {
  prompt: string;
  spec: DesignSpec;
  brand: BrandKit;
  template: DesignTemplate;
}

export interface ImageGenResult {
  imageBase64Png?: string;
  svg?: string;
  note?: string;
}

export type ImageGenFn = (request: ImageGenRequest) => Promise<ImageGenResult>;

const HEX = /^#[0-9a-fA-F]{6}$/;
const BRAND_KIND = "design_brand_kits";
const DESIGN_KIND = "design_outputs";
const DESIGN_DIR = path.join(DATA_DIR, "design");

export const DEFAULT_BRAND: Omit<BrandKit, "id" | "name" | "createdAt" | "updatedAt"> = {
  colors: {
    primary: "#1d4ed8",
    secondary: "#0ea5e9",
    accent: "#f59e0b",
    background: "#0f172a",
    text: "#f8fafc",
  },
  fonts: { heading: "Georgia, serif", body: "Helvetica, Arial, sans-serif" },
  logoRefs: [],
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function safeFileSegment(id: string, prefix: string): string {
  if (!new RegExp(`^${prefix}_[a-z0-9_]+$`).test(id)) throw new Error(`invalid ${prefix} id`);
  return id;
}

/** Templated layouts (JSON). Sizes in canvas units. */
export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    id: "poster",
    name: "Poster",
    description: "Portrait poster: badge chip, big title, subtitle, accent shape, logo corner.",
    canvas: { width: 800, height: 1200 },
    slots: [
      { id: "accent", type: "shape", colorRole: "accent", fontRole: "none", x: 60, y: 80, width: 680, height: 14, align: "left" },
      { id: "badge", type: "badge", colorRole: "primary", fontRole: "body", x: 60, y: 120, width: 680, height: 44, align: "left" },
      { id: "title", type: "title", colorRole: "text", fontRole: "heading", x: 60, y: 220, width: 680, height: 480, align: "left" },
      { id: "subtitle", type: "subtitle", colorRole: "secondary", fontRole: "body", x: 60, y: 720, width: 680, height: 220, align: "left" },
      { id: "logo", type: "logo", colorRole: "accent", fontRole: "body", x: 60, y: 1060, width: 220, height: 80, align: "left" },
    ],
  },
  {
    id: "banner",
    name: "Banner",
    description: "Wide landscape banner: title left, subtitle below, image block right.",
    canvas: { width: 1600, height: 640 },
    slots: [
      { id: "title", type: "title", colorRole: "text", fontRole: "heading", x: 70, y: 140, width: 820, height: 220, align: "left" },
      { id: "subtitle", type: "subtitle", colorRole: "secondary", fontRole: "body", x: 70, y: 360, width: 820, height: 140, align: "left" },
      { id: "image", type: "image", colorRole: "primary", fontRole: "none", x: 950, y: 70, width: 580, height: 500, align: "center" },
      { id: "logo", type: "logo", colorRole: "accent", fontRole: "body", x: 70, y: 520, width: 220, height: 70, align: "left" },
    ],
  },
  {
    id: "social_card",
    name: "Social card",
    description: "Square card: centered title/subtitle over an accent strip, logo bottom.",
    canvas: { width: 1080, height: 1080 },
    slots: [
      { id: "accent", type: "shape", colorRole: "accent", fontRole: "none", x: 90, y: 90, width: 900, height: 10, align: "center" },
      { id: "title", type: "title", colorRole: "text", fontRole: "heading", x: 90, y: 260, width: 900, height: 320, align: "center" },
      { id: "subtitle", type: "subtitle", colorRole: "secondary", fontRole: "body", x: 90, y: 600, width: 900, height: 220, align: "center" },
      { id: "badge", type: "badge", colorRole: "primary", fontRole: "body", x: 90, y: 880, width: 900, height: 60, align: "center" },
    ],
  },
];

export function getTemplate(id: string): DesignTemplate | undefined {
  return DESIGN_TEMPLATES.find((t) => t.id === id);
}

/** Keyword heuristic mapping a free-form brief to one of the layouts. */
export function pickTemplateId(brief: string): string {
  const b = brief.toLowerCase();
  if (/(banner|header|wide|cover|hero)/.test(b)) return "banner";
  if (/(poster|flyer|event|print|\bad\b)/.test(b)) return "poster";
  return "social_card";
}

/** Deterministic brief → copy blocks. First line/sentence becomes the title. */
export function parseBrief(brief: string): ParsedBrief {
  const text = brief.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("brief is required");
  const parts = text.split(/(?<=[.!?])\s+/);
  const first = parts[0] ?? text;
  const title = first.length > 80 ? `${first.slice(0, 77)}...` : first;
  const rest = parts.slice(1).join(" ").trim();
  const subtitle = rest ? (rest.length > 180 ? `${rest.slice(0, 177)}...` : rest) : text.length > 80 ? text.split(" ").slice(8).join(" ").slice(0, 180) : "";
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4);
  const tags = [...new Set(words)].slice(0, 3);
  return { title, subtitle, tags };
}

export function normalizeHex(value: unknown, fallback: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  return HEX.test(s) ? s.toLowerCase() : fallback;
}

/** A logo ref becomes an SVG <image href>. Only safe schemes and plain paths
 *  are accepted: script-capable or non-image data URIs are dropped rather than
 *  embedded into a document the studio serves as image/svg+xml. */
export function isRenderableLogoRef(ref: string): boolean {
  const s = ref.trim();
  if (!s) return false;
  if (s.startsWith("//")) return false;
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(s);
  if (!scheme) return true;
  const lower = s.toLowerCase();
  if (lower.startsWith("data:")) return lower.startsWith("data:image/");
  return lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("file:");
}

export function validateBrandKitInput(raw: unknown): Omit<BrandKit, "id" | "createdAt" | "updatedAt"> {
  if (!raw || typeof raw !== "object") throw new Error("brand kit object required");
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("brand kit name is required");
  const colorsIn = (body.colors ?? {}) as Record<string, unknown>;
  const colors: BrandColors = {
    primary: normalizeHex(colorsIn.primary, DEFAULT_BRAND.colors.primary),
    secondary: normalizeHex(colorsIn.secondary, DEFAULT_BRAND.colors.secondary),
    accent: normalizeHex(colorsIn.accent, DEFAULT_BRAND.colors.accent),
    background: normalizeHex(colorsIn.background, DEFAULT_BRAND.colors.background),
    text: normalizeHex(colorsIn.text, DEFAULT_BRAND.colors.text),
  };
  const fontsIn = (body.fonts ?? {}) as Record<string, unknown>;
  const font = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : fallback);
  const fonts: BrandFonts = {
    heading: font(fontsIn.heading, DEFAULT_BRAND.fonts.heading),
    body: font(fontsIn.body, DEFAULT_BRAND.fonts.body),
  };
  const logoRefs = Array.isArray(body.logoRefs)
    ? body.logoRefs
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 500))
        .filter((x) => isRenderableLogoRef(x))
        .slice(0, 8)
    : [];
  return { name: name.slice(0, 120), colors, fonts, logoRefs };
}

// ---------------------------------------------------------------------------
// Brand kit storage (entity-store pattern)
// ---------------------------------------------------------------------------

export function saveBrandKit(input: unknown, id?: string): BrandKit {
  const clean = validateBrandKitInput(input);
  const now = new Date().toISOString();
  const existing = id ? getEntity<BrandKit>(BRAND_KIND, id) : undefined;
  if (id && !existing) throw new Error("brand kit not found");
  const kit: BrandKit = {
    id: existing?.id ?? newId("kit"),
    name: clean.name,
    colors: clean.colors,
    fonts: clean.fonts,
    logoRefs: clean.logoRefs,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  putEntity(BRAND_KIND, kit);
  return kit;
}

export function getBrandKit(id: string): BrandKit | undefined {
  return getEntity<BrandKit>(BRAND_KIND, id);
}

/** Newest-first, as stored by allEntities. */
export function listBrandKits(): BrandKit[] {
  return allEntities<BrandKit>(BRAND_KIND);
}

export function deleteBrandKit(id: string): boolean {
  return removeEntity(BRAND_KIND, id);
}

function resolveBrand(brandKitId?: string): BrandKit {
  if (brandKitId) {
    const kit = getBrandKit(brandKitId);
    if (!kit) throw new Error("brand kit not found");
    return kit;
  }
  const latest = listBrandKits()[0];
  if (latest) return latest;
  const now = new Date().toISOString();
  return { id: "kit_default", name: "Default", ...DEFAULT_BRAND, createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Template fill (pure, deterministic)
// ---------------------------------------------------------------------------

function slotFontSize(type: SlotType, slotHeight: number, canvasHeight: number): number {
  if (type === "title") return Math.round(Math.min(slotHeight / 4.2, canvasHeight / 8));
  if (type === "subtitle") return Math.round(Math.min(slotHeight / 5.5, canvasHeight / 18));
  if (type === "badge") return Math.round(slotHeight / 2.4);
  return 16;
}

export function fillTemplate(templateId: string, brand: BrandKit, brief: ParsedBrief): DesignSpec {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`unknown design template: ${templateId}`);
  const slots: FilledSlot[] = template.slots.map((slot) => {
    const color = slot.colorRole === "none" ? brand.colors.accent : brand.colors[slot.colorRole];
    const font = slot.fontRole === "none" ? brand.fonts.body : brand.fonts[slot.fontRole];
    const filled: FilledSlot = {
      id: slot.id,
      type: slot.type,
      color,
      font,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
      align: slot.align,
    };
    if (slot.type === "title") filled.text = brief.title;
    else if (slot.type === "subtitle") filled.text = brief.subtitle;
    else if (slot.type === "badge") filled.text = brief.tags.length > 0 ? brief.tags.map((t) => `#${t}`).join("  ") : brand.name;
    else if (slot.type === "logo" && brand.logoRefs.length > 0) filled.src = brand.logoRefs[0];
    return filled;
  });
  return { templateId: template.id, canvas: { ...template.canvas }, background: brand.colors.background, slots };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wrap plain text into lines that roughly fit the slot width. */
function wrapText(text: string, boxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(8, Math.floor((boxWidth / fontSize) * 1.9));
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (lines.length === 0) lines.push(word);
    else if ((lines.at(-1) ?? "").length + 1 + word.length <= maxChars) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

export function renderSpecToSvg(spec: DesignSpec, brand: BrandKit): string {
  const { width, height } = spec.canvas;
  const body: string[] = [];
  body.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${spec.background}"/>`);
  for (const slot of spec.slots) {
    const cx = slot.align === "center" ? slot.x + slot.width / 2 : slot.align === "right" ? slot.x + slot.width : slot.x;
    if (slot.type === "shape") {
      body.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" rx="${Math.min(8, slot.height / 2)}" fill="${slot.color}"/>`);
      continue;
    }
    if (slot.type === "image") {
      body.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" rx="24" fill="${slot.color}" opacity="0.28"/>`);
      body.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" rx="24" fill="none" stroke="${slot.color}" stroke-width="3"/>`);
      continue;
    }
    if (slot.type === "logo" && slot.src) {
      const href = /^(https?:|data:|file:)/.test(slot.src) ? slot.src : `file:///${slot.src.replace(/\\/g, "/").replace(/^\/+/, "")}`;
      body.push(`<image href="${esc(href)}" x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" preserveAspectRatio="xMidYMid meet"/>`);
      continue;
    }
    if (slot.type === "logo") {
      body.push(`<text x="${cx}" y="${slot.y + slot.height * 0.6}" font-family="${esc(brand.fonts.body)}" font-size="${Math.round(slot.height / 2.4)}" fill="${slot.color}" text-anchor="${slot.align === "center" ? "middle" : "start"}">${esc(brand.name)}</text>`);
      continue;
    }
    const text = (slot.text ?? "").trim();
    if (!text) continue;
    if (slot.type === "badge") {
      body.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" rx="${slot.height / 2}" fill="${slot.color}" opacity="0.85"/>`);
      body.push(`<text x="${cx}" y="${slot.y + slot.height * 0.62}" font-family="${esc(slot.font)}" font-size="${slotFontSize(slot.type, slot.height, height)}" fill="${brand.colors.text}" text-anchor="${slot.align === "center" ? "middle" : "start"}">${esc(text)}</text>`);
      continue;
    }
    const fontSize = slotFontSize(slot.type, slot.height, height);
    const lineHeight = Math.round(fontSize * 1.18);
    const lines = wrapText(text, slot.width, fontSize);
    lines.forEach((line, i) => {
      body.push(`<text x="${cx}" y="${slot.y + fontSize + i * lineHeight}" font-family="${esc(slot.font)}" font-size="${fontSize}" fill="${slot.color}" text-anchor="${slot.align === "center" ? "middle" : "start"}">${esc(line)}</text>`);
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body.join("\n")}\n</svg>\n`;
}

// ---------------------------------------------------------------------------
// Generate step
// ---------------------------------------------------------------------------

export async function generateDesign(input: {
  brief: string;
  brandKitId?: string;
  templateId?: string;
}, deps: { imageGen?: ImageGenFn } = {}): Promise<{ record: DesignRecord; spec: DesignSpec }> {
  const brief = String(input.brief ?? "").trim();
  if (!brief) throw new Error("brief is required");
  const brand = resolveBrand(input.brandKitId);
  const templateId = input.templateId && getTemplate(input.templateId) ? input.templateId : pickTemplateId(brief);
  const template = getTemplate(templateId);
  if (!template) throw new Error(`unknown design template: ${templateId}`);
  const parsed = parseBrief(brief);
  const spec = fillTemplate(template.id, brand, parsed);

  fs.mkdirSync(DESIGN_DIR, { recursive: true });
  const id = newId("design");
  const specFile = path.join(DESIGN_DIR, `${safeFileSegment(id, "design")}.json`);
  const svgFile = `${specFile.replace(/\.json$/, "")}.svg`;

  let svg = renderSpecToSvg(spec, brand);
  let generator: DesignRecord["generator"] = "builtin-svg";
  let imageFile: string | undefined;

  if (deps.imageGen) {
    const gen = await deps.imageGen({ prompt: brief, spec, brand, template });
    if (gen.svg) svg = gen.svg;
    if (gen.imageBase64Png) {
      imageFile = svgFile.replace(/\.svg$/, ".png");
      fs.writeFileSync(imageFile, Buffer.from(gen.imageBase64Png, "base64"));
    }
    if (gen.svg || gen.imageBase64Png) generator = "injected-image-tool";
  }

  fs.writeFileSync(specFile, JSON.stringify({ brief, brand, spec }, null, 1), "utf8");
  fs.writeFileSync(svgFile, svg, "utf8");
  if (!imageFile) {
    // Best-effort raster: sharp is already a repo dependency. SVG stays the
    // authoritative artifact; PNG absence is not a failure.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharp = (await import("sharp")).default as any;
      const png = await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer();
      imageFile = svgFile.replace(/\.svg$/, ".png");
      fs.writeFileSync(imageFile, png);
    } catch {
      imageFile = undefined;
    }
  }

  const record: DesignRecord = {
    id,
    brief: brief.slice(0, 4000),
    templateId: template.id,
    brandKitId: brand.id,
    brandName: brand.name,
    specFile,
    svgFile,
    ...(imageFile ? { imageFile } : {}),
    generator,
    createdAt: new Date().toISOString(),
  };
  putEntity(DESIGN_KIND, record);
  return { record, spec };
}

export function getDesign(id: string): DesignRecord | undefined {
  return getEntity<DesignRecord>(DESIGN_KIND, id);
}

export function listDesigns(limit = 20): DesignRecord[] {
  return allEntities<DesignRecord>(DESIGN_KIND).slice(0, limit);
}
