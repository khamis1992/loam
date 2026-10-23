/**
 * UI asset generation for generated pages (Loam UI Kit).
 *
 * A generated page must ship real, local images instead of placeholder URLs,
 * and every image must carry accessible alt text. This module is the asset
 * stage of the design pipeline and provides:
 *
 *   - `isPlaceholderUrl` / `auditPageImages` — find placeholder hosts and
 *     images missing alt text in a page.
 *   - `renderUiAssetSvg` / `generateUiAssets` — produce real local assets,
 *     deterministically by default, or through an injected image generator
 *     (a model-backed provider) when the host wires one.
 *   - `rewritePageImages` / `resolvePageAssets` — replace placeholder `src`
 *     values with local asset paths and fill missing alt text, so the finished
 *     page passes `auditPageImages(...).ok`.
 *
 * No external model is contacted here. The default generator is fully local and
 * deterministic; a real provider is injected by the caller, never by the model.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveWrite } from "../policy/paths.js";

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/** Hosts that only ever serve stand-in images. */
const PLACEHOLDER_DOMAINS: ReadonlySet<string> = new Set([
  "placehold.co",
  "placeholder.com",
  "via.placeholder.com",
  "dummyimage.com",
  "placeholdit.net",
  "picsum.photos",
  "placekitten.com",
  "lorempixel.com",
  "loremflickr.com",
  "fakeimg.pl",
  "placeimg.com",
  "placebear.com",
  "baconmockup.com",
  "fillmurray.com",
  "placecage.com",
  "placesheen.com",
]);

/** Path fragments that also signal a stand-in image even on a custom host. */
const PLACEHOLDER_PATH_PATTERNS: readonly RegExp[] = [
  /\/placeholder[s]?\//i,
  /\/placeholders?\./i,
  /[?&]placeholder\b/i,
];

/** True when `url` points at a placeholder/stand-in image service. */
export function isPlaceholderUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split(/[/?#]/, 1)[0]?.toLowerCase() ?? "";
  if (!host) return false;
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  for (const domain of PLACEHOLDER_DOMAINS) {
    if (bare === domain || bare.endsWith(`.${domain}`)) return true;
  }
  return PLACEHOLDER_PATH_PATTERNS.some((re) => re.test(trimmed));
}

// ---------------------------------------------------------------------------
// HTML image parsing + audit
// ---------------------------------------------------------------------------

const IMG_TAG_SOURCE = "<img\\b[^>]*>";
const IMG_TAG_RE = new RegExp(IMG_TAG_SOURCE, "gi");

export interface ImgTagMatch {
  /** The complete matched `<img ...>` string. */
  tag: string;
  /** Character offset of the tag in the source HTML. */
  index: number;
  /** Raw `src` value (empty when absent). */
  src: string;
  /** Raw `alt` value; undefined when the attribute is absent. */
  alt?: string;
  /** Lower-cased attribute map. */
  attrs: Record<string, string>;
}

export interface PageImageDetail {
  src: string;
  hasAlt: boolean;
  placeholder: boolean;
}

export interface PageImageAudit {
  images: number;
  /** `src` values that resolve to a placeholder service. */
  placeholders: string[];
  /** `src` values whose image has no non-empty alt text. */
  missingAlt: string[];
  /** True when there are no placeholders and no missing alt text. */
  ok: boolean;
  detail: PageImageDetail[];
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1]!.toLowerCase();
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Parse every `<img>` tag in `html` without executing anything. */
export function parseImgTags(html: string): ImgTagMatch[] {
  const out: ImgTagMatch[] = [];
  const re = new RegExp(IMG_TAG_SOURCE, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseAttrs(tag);
    out.push({ tag, index: m.index, src: attrs.src ?? "", alt: attrs.alt, attrs });
  }
  return out;
}

/** Audit a page for placeholder URLs and missing alt text. */
export function auditPageImages(html: string): PageImageAudit {
  const detail: PageImageDetail[] = parseImgTags(html).map((img) => ({
    src: img.src,
    hasAlt: typeof img.alt === "string" && img.alt.trim().length > 0,
    placeholder: isPlaceholderUrl(img.src),
  }));
  const placeholders = detail.filter((d) => d.placeholder).map((d) => d.src);
  const missingAlt = detail.filter((d) => !d.hasAlt).map((d) => d.src);
  return {
    images: detail.length,
    placeholders,
    missingAlt,
    ok: placeholders.length === 0 && missingAlt.length === 0,
    detail,
  };
}

// ---------------------------------------------------------------------------
// HTML rewriting
// ---------------------------------------------------------------------------

type StringMap = Record<string, string> | Map<string, string>;

function mapGet(map: StringMap | undefined, key: string): string | undefined {
  if (!map) return undefined;
  return map instanceof Map ? map.get(key) : map[key];
}

function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  const escaped = escapeAttr(value);
  if (re.test(tag)) return tag.replace(re, `$1${name}="${escaped}"`);
  const idx = tag.lastIndexOf(">");
  if (idx < 0) return tag;
  const selfClose = /\/\s*$/.test(tag.slice(0, idx));
  const insertAt = selfClose ? idx - 1 : idx;
  return `${tag.slice(0, insertAt)} ${name}="${escaped}"${tag.slice(insertAt)}`;
}

export interface RewritePageInput {
  html: string;
  /** Map original `src` -> local `src` for replacement. */
  srcMap?: StringMap;
  /** Map original `src` -> alt text for images missing alt text. */
  altBySrc?: StringMap;
  /** Fallback alt applied to any image still missing alt after the map. */
  defaultAlt?: string;
}

export interface RewritePageResult {
  html: string;
  replaced: number;
  altFilled: number;
}

/** Replace placeholder `src` values and fill missing alt text in place. */
export function rewritePageImages(input: RewritePageInput): RewritePageResult {
  let replaced = 0;
  let altFilled = 0;
  const html = input.html.replace(IMG_TAG_RE, (tag) => {
    let out = tag;
    const src = getAttr(out, "src") ?? "";
    const newSrc = mapGet(input.srcMap, src);
    if (newSrc && newSrc !== src) {
      out = setAttr(out, "src", newSrc);
      replaced += 1;
    }
    const existingAlt = getAttr(out, "alt");
    const hasAltText = typeof existingAlt === "string" && existingAlt.trim().length > 0;
    if (!hasAltText) {
      const alt = mapGet(input.altBySrc, src) ?? input.defaultAlt;
      if (alt && alt.trim().length > 0) {
        out = setAttr(out, "alt", alt);
        altFilled += 1;
      }
    }
    return out;
  });
  return { html, replaced, altFilled };
}

// ---------------------------------------------------------------------------
// Local asset generation
// ---------------------------------------------------------------------------

export interface UiAssetPalette {
  background: string;
  accent: string;
  foreground: string;
}

export interface UiAssetRequest {
  /** What the image should depict. */
  prompt: string;
  /** Required accessible description; must be non-empty. */
  alt: string;
  width?: number;
  height?: number;
  /** Deterministic variant seed. */
  seed?: string;
  /** Optional on-brand palette. */
  palette?: UiAssetPalette;
}

export interface UiAssetBytes {
  bytes: Buffer;
  format: "svg" | "png" | "jpeg" | "webp";
  width?: number;
  height?: number;
}

export type UiAssetGenerator = (request: UiAssetRequest) => Promise<UiAssetBytes>;

export type UiAssetFormat = "svg" | "png" | "jpeg" | "webp";

export interface UiAssetRecord {
  id: string;
  prompt: string;
  alt: string;
  /** Public URL path to reference from the page. */
  src: string;
  /** Absolute file path on disk. */
  file: string;
  width: number;
  height: number;
  format: UiAssetFormat;
  /** "local-svg" for the builtin generator, "injected" for a host provider. */
  generator: "local-svg" | "injected";
}

export const DEFAULT_UI_ASSET_PALETTE: UiAssetPalette = {
  background: "#0f172a",
  accent: "#38bdf8",
  foreground: "#f8fafc",
};

export const DEFAULT_PUBLIC_BASE = "/assets/ui";
export const DEFAULT_OUT_DIR = "public/assets/ui";

const MIN_DIMENSION = 16;
const MAX_DIMENSION = 4096;

function clampInt(value: number, def: number): number {
  if (!Number.isFinite(value)) return def;
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(value)));
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a deterministic, brand-tinted SVG composition for a request. */
export function renderUiAssetSvg(request: UiAssetRequest): string {
  const width = clampInt(request.width ?? 800, 800);
  const height = clampInt(request.height ?? 600, 600);
  const palette = request.palette ?? DEFAULT_UI_ASSET_PALETTE;
  const seed = hash32(`${request.prompt}::${request.seed ?? ""}::${width}x${height}`);
  const rng = mulberry32(seed);
  const parts: string[] = [];
  const altText = request.alt.trim() || request.prompt.trim() || "Generated UI asset";
  parts.push(`<title>${escapeXml(altText)}</title>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${palette.background}"/>`);

  // A large soft accent circle anchors the composition.
  const cx = Math.round(width * (0.22 + rng() * 0.56));
  const cy = Math.round(height * (0.2 + rng() * 0.55));
  const r = Math.round(Math.min(width, height) * (0.16 + rng() * 0.2));
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${palette.accent}" opacity="0.22"/>`);

  // A second, smaller circle in the foreground tone adds depth.
  const cx2 = Math.round(width * (0.55 + rng() * 0.35));
  const cy2 = Math.round(height * (0.55 + rng() * 0.3));
  const r2 = Math.round(Math.min(width, height) * (0.06 + rng() * 0.1));
  parts.push(`<circle cx="${cx2}" cy="${cy2}" r="${r2}" fill="${palette.foreground}" opacity="0.18"/>`);

  // A horizontal accent band gives the asset a clear focal element.
  const bandHeight = Math.max(8, Math.round(height * 0.06));
  const bandWidth = Math.round(width * (0.35 + rng() * 0.4));
  const bandX = Math.round(width * 0.08);
  const bandY = Math.round(height * (0.5 + rng() * 0.3));
  parts.push(`<rect x="${bandX}" y="${bandY}" width="${bandWidth}" height="${bandHeight}" rx="${Math.round(bandHeight / 2)}" fill="${palette.accent}"/>`);

  // A row of accent dots balances the lower third.
  const dots = 3 + Math.floor(rng() * 3);
  const dotY = Math.round(height * (0.78 + rng() * 0.1));
  for (let i = 0; i < dots; i += 1) {
    const dx = Math.round(width * (0.1 + (i * 0.7) / Math.max(1, dots - 1)));
    parts.push(`<circle cx="${dx}" cy="${dotY}" r="${Math.max(4, Math.round(height * 0.012))}" fill="${i === 0 ? palette.foreground : palette.accent}" opacity="${i === 0 ? 0.9 : 0.55}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">\n${parts.join("\n")}\n</svg>\n`;
}

/** Default local generator: SVG, rasterized to PNG when sharp is available. */
async function defaultAssetGenerator(request: UiAssetRequest): Promise<UiAssetBytes> {
  const width = clampInt(request.width ?? 800, 800);
  const height = clampInt(request.height ?? 600, 600);
  const svg = renderUiAssetSvg(request);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharp = (await import("sharp")).default as any;
    const png = await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer();
    return { bytes: png, format: "png", width, height };
  } catch {
    return { bytes: Buffer.from(svg, "utf8"), format: "svg", width, height };
  }
}

function normalizeFormat(format: string): UiAssetFormat {
  const f = format.toLowerCase();
  if (f === "png" || f === "jpeg" || f === "jpg" || f === "webp" || f === "svg") {
    return f === "jpg" ? "jpeg" : f;
  }
  return "png";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

function normalizePublicBase(base: string): string {
  let b = base.trim();
  if (!b) return DEFAULT_PUBLIC_BASE;
  if (!b.startsWith("/")) b = `/${b}`;
  return b.replace(/\/+$/, "");
}

export interface GenerateUiAssetsOptions {
  /** Workspace root; assets are written under it. */
  workspace: string;
  requests: UiAssetRequest[];
  /** Injected provider; defaults to the local deterministic generator. */
  generator?: UiAssetGenerator;
  /** Public URL base; defaults to "/assets/ui". */
  publicBase?: string;
  /** Output directory relative to the workspace. */
  outDir?: string;
}

export interface GenerateUiAssetsResult {
  assets: UiAssetRecord[];
  /** Public URL paths, in request order. */
  files: string[];
}

/** Generate every requested asset into the workspace and return records. */
export async function generateUiAssets(opts: GenerateUiAssetsOptions): Promise<GenerateUiAssetsResult> {
  const requests = opts.requests ?? [];
  if (requests.length === 0) throw new Error("at least one asset request is required");
  const outDir = resolveWrite(opts.workspace, opts.outDir ?? DEFAULT_OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const publicBase = normalizePublicBase(opts.publicBase ?? DEFAULT_PUBLIC_BASE);
  const generator = opts.generator ?? defaultAssetGenerator;
  const assets: UiAssetRecord[] = [];
  const files: string[] = [];
  for (let i = 0; i < requests.length; i += 1) {
    const request = requests[i]!;
    const prompt = request.prompt.trim();
    const alt = request.alt.trim();
    if (!prompt) throw new Error(`requests[${i}].prompt is required`);
    if (!alt) throw new Error(`requests[${i}].alt is required`);
    const id = newAssetId(i, prompt, request.seed);
    const result = await generator({ ...request, prompt, alt });
    const format = normalizeFormat(result.format);
    const file = path.join(outDir, `${id}.${format}`);
    fs.writeFileSync(file, result.bytes);
    const width = clampInt(result.width ?? request.width ?? 800, 800);
    const height = clampInt(result.height ?? request.height ?? 600, 600);
    const src = `${publicBase}/${id}.${format}`;
    const record: UiAssetRecord = {
      id,
      prompt: prompt.slice(0, 500),
      alt,
      src,
      file,
      width,
      height,
      format,
      generator: opts.generator ? "injected" : "local-svg",
    };
    assets.push(record);
    files.push(src);
  }
  return { assets, files };
}

function newAssetId(index: number, prompt: string, seed?: string): string {
  const h = hash32(`${prompt}::${seed ?? ""}::${index}`).toString(36);
  const slug = slugify(prompt).slice(0, 40);
  return `ui_${h}${slug ? `_${slug}` : ""}`;
}

/** Build a complete, accessible `<img>` tag for a generated asset. */
export function buildImgTag(
  record: Pick<UiAssetRecord, "src" | "alt" | "width" | "height">,
  opts: { className?: string; lazy?: boolean } = {},
): string {
  const cls = opts.className ? ` class="${escapeAttr(opts.className)}"` : "";
  const lazy = opts.lazy === false ? "" : ` loading="lazy"`;
  return `<img src="${escapeAttr(record.src)}" alt="${escapeAttr(record.alt)}" width="${record.width}" height="${record.height}"${lazy}${cls} />`;
}

// ---------------------------------------------------------------------------
// End-to-end page resolution
// ---------------------------------------------------------------------------

export interface ResolvePageAssetsOptions {
  workspace: string;
  /** One request per placeholder image, in page order. */
  requests: UiAssetRequest[];
  generator?: UiAssetGenerator;
  publicBase?: string;
  outDir?: string;
  /** Fallback alt applied to any image still missing alt after the map. */
  defaultAlt?: string;
}

export interface ResolvePageAssetsResult {
  /** Rewritten page HTML. */
  html: string;
  assets: UiAssetRecord[];
  /** Audit of the original HTML. */
  audit: PageImageAudit;
  /** Audit of the rewritten HTML. */
  finalAudit: PageImageAudit;
  replaced: number;
  altFilled: number;
}

/**
 * Resolve every placeholder in a page: generate a local asset per placeholder
 * and rewrite the page so it references those assets with alt text. Throws when
 * fewer requests than placeholders are supplied, so a caller can never silently
 * leave a placeholder behind.
 */
export async function resolvePageAssets(html: string, opts: ResolvePageAssetsOptions): Promise<ResolvePageAssetsResult> {
  const audit = auditPageImages(html);
  const placeholderSrcs = audit.detail.filter((d) => d.placeholder).map((d) => d.src);
  if (placeholderSrcs.length === 0) {
    return { html, assets: [], audit, finalAudit: audit, replaced: 0, altFilled: 0 };
  }
  if (opts.requests.length < placeholderSrcs.length) {
    throw new Error(
      `page has ${placeholderSrcs.length} placeholder image(s) but only ${opts.requests.length} asset request(s) were provided`,
    );
  }
  const generated = await generateUiAssets({
    workspace: opts.workspace,
    requests: opts.requests,
    generator: opts.generator,
    publicBase: opts.publicBase,
    outDir: opts.outDir,
  });
  const srcMap = new Map<string, string>();
  const altBySrc = new Map<string, string>();
  placeholderSrcs.forEach((src, i) => {
    const asset = generated.assets[i];
    if (!asset) return;
    srcMap.set(src, asset.src);
    altBySrc.set(src, asset.alt);
  });
  const rewrite = rewritePageImages({ html, srcMap, altBySrc, defaultAlt: opts.defaultAlt });
  const finalAudit = auditPageImages(rewrite.html);
  return {
    html: rewrite.html,
    assets: generated.assets,
    audit,
    finalAudit,
    replaced: rewrite.replaced,
    altFilled: rewrite.altFilled,
  };
}

/** A short, human-readable summary used by the agent tool response. */
export function summarizePageAssets(audit: PageImageAudit): string {
  const parts = [`images=${audit.images}`];
  if (audit.placeholders.length > 0) parts.push(`placeholders=${audit.placeholders.length}`);
  if (audit.missingAlt.length > 0) parts.push(`missingAlt=${audit.missingAlt.length}`);
  parts.push(audit.ok ? "ok" : "needs-work");
  return parts.join(" ");
}

/** Stable id helper (exposed for tests and callers that precompute names). */
export function uiAssetId(index: number, prompt: string, seed?: string): string {
  return newAssetId(index, prompt.trim(), seed);
}
