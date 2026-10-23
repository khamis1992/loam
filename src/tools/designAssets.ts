/**
 * Design asset agent tools (Loam UI Kit, V12).
 *
 * `design_image_generate` writes real, local image assets into the task's
 * `public/assets/ui/` and returns the public `src` plus a ready `<img>` tag for
 * each. `design_page_images` audits or rewrites a generated page: it detects
 * placeholder image URLs and missing alt text, then replaces every placeholder
 * with a locally generated asset and fills the alt text, so the finished page
 * passes the audit with no placeholders and no image without alt.
 *
 * Both tools use the deterministic local generator by default; a host can inject
 * a model-backed provider through `createDesignAssetsTools({ generator })`.
 * Nothing here calls an external model.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveWrite } from "../policy/paths.js";
import {
  auditPageImages,
  buildImgTag,
  generateUiAssets,
  resolvePageAssets,
  summarizePageAssets,
  type UiAssetGenerator,
  type UiAssetPalette,
  type UiAssetRequest,
} from "../design/assets.js";
import { str, type Tool } from "./registry.js";

export interface DesignAssetsDeps {
  /** Injected image provider; defaults to the local deterministic generator. */
  generator?: UiAssetGenerator;
}

export const DESIGN_ASSETS_TOOL_NAMES = ["design_image_generate", "design_page_images"];

function parsePalette(raw: unknown): UiAssetPalette | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const hex = (v: unknown): string | undefined => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : undefined);
  const palette: UiAssetPalette = {
    background: hex(o.background) ?? "#0f172a",
    accent: hex(o.accent) ?? "#38bdf8",
    foreground: hex(o.foreground) ?? "#f8fafc",
  };
  return palette;
}

function parseRequests(raw: unknown): UiAssetRequest[] {
  if (!Array.isArray(raw)) throw new Error("requests must be an array");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`requests[${index}] must be an object`);
    const o = item as Record<string, unknown>;
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    const alt = typeof o.alt === "string" ? o.alt.trim() : "";
    if (!prompt) throw new Error(`requests[${index}].prompt is required`);
    if (!alt) throw new Error(`requests[${index}].alt is required`);
    const width = typeof o.width === "number" && Number.isFinite(o.width) ? o.width : undefined;
    const height = typeof o.height === "number" && Number.isFinite(o.height) ? o.height : undefined;
    const seed = typeof o.seed === "string" && o.seed.trim() ? o.seed.trim() : undefined;
    const palette = parsePalette(o.palette);
    return {
      prompt,
      alt,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(seed ? { seed } : {}),
      ...(palette ? { palette } : {}),
    };
  });
}

function singleRequest(args: Record<string, unknown>): UiAssetRequest[] {
  const prompt = str(args, "prompt").trim();
  if (!prompt) throw new Error("prompt is required (or pass a requests array)");
  const alt = str(args, "alt").trim();
  if (!alt) throw new Error("alt is required: every generated image needs accessible alt text");
  return [{ prompt, alt }];
}

export function createDesignAssetsTools(deps: DesignAssetsDeps = {}): Tool[] {
  return [
    {
      name: "design_image_generate",
      description:
        "Generate real, local image assets for a generated page and write them into the task's public/assets/ui/ directory. Use this instead of any placeholder image service: pass one request per image with a specific prompt and a non-empty alt that describes the image for screen readers (Arabic pages use Arabic alt and dir=rtl). Returns each asset's public src (reference it with a relative path, never a placeholder URL), its width/height, and a ready <img> tag. Without an injected provider the assets are generated locally and deterministically, so this always succeeds offline.",
      parameters: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: "Images to generate, in page order. Use this or the prompt/alt shorthand, not both.",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "What the image should depict, in concrete terms." },
                alt: { type: "string", description: "Required accessible description of the image." },
                width: { type: "integer", description: "Pixel width (default 800)." },
                height: { type: "integer", description: "Pixel height (default 600)." },
                seed: { type: "string", description: "Deterministic variant seed." },
                palette: { type: "object", description: "Optional {background,accent,foreground} hex palette." },
              },
              required: ["prompt", "alt"],
            },
          },
          prompt: { type: "string", description: "Shorthand for a single image when no requests array is given." },
          alt: { type: "string", description: "Shorthand alt text for the single-image form." },
          outDir: { type: "string", description: "Output directory relative to the task workspace (default public/assets/ui)." },
          publicBase: { type: "string", description: "Public URL base for src values (default /assets/ui)." },
        },
      },
      async run(args, ctx) {
        try {
          const raw = args.requests;
          const requests = raw === undefined ? singleRequest(args) : parseRequests(raw);
          const generated = await generateUiAssets({
            workspace: ctx.workspace,
            requests,
            generator: deps.generator,
            ...(str(args, "outDir") ? { outDir: str(args, "outDir") } : {}),
            ...(str(args, "publicBase") ? { publicBase: str(args, "publicBase") } : {}),
          });
          return {
            ok: true,
            content: JSON.stringify({
              assets: generated.assets,
              files: generated.files,
              imgTags: generated.assets.map((asset) => buildImgTag(asset)),
              hint: "Reference each asset with its public src and keep the alt text; never link a placeholder URL.",
            }),
          };
        } catch (error) {
          return { ok: false, content: `design_image_generate failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
    {
      name: "design_page_images",
      description:
        "Audit or repair the images in a generated page. action=audit reports every placeholder image URL (placehold.co, picsum.photos, via.placeholder.com and similar) and every <img> without alt text. action=rewrite generates a local asset for each placeholder — supply one requests entry per placeholder in page order, each with a concrete prompt and non-empty alt — then rewrites the HTML so every image points at a local src and carries alt text. The response includes the rewritten HTML and the before/after audit so you can confirm there are no placeholders and no missing alt. Use action=rewrite before finishing any page that renders images.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["audit", "rewrite"], description: "audit reports problems; rewrite repairs them. Defaults to audit." },
          html: { type: "string", description: "The page HTML to inspect or repair." },
          requests: {
            type: "array",
            description: "One asset request per placeholder, in page order (required for action=rewrite).",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                alt: { type: "string" },
                width: { type: "integer" },
                height: { type: "integer" },
                seed: { type: "string" },
                palette: { type: "object" },
              },
              required: ["prompt", "alt"],
            },
          },
          outPath: { type: "string", description: "Optional task-relative path to write the repaired HTML to." },
          outDir: { type: "string", description: "Asset output directory (default public/assets/ui)." },
          publicBase: { type: "string", description: "Public URL base for generated assets (default /assets/ui)." },
          defaultAlt: { type: "string", description: "Fallback alt for any image still missing alt after per-placeholder alt is applied." },
        },
        required: ["html"],
      },
      async run(args, ctx) {
        try {
          const html = str(args, "html");
          if (!html.trim()) return { ok: false, content: "html is required" };
          const action = str(args, "action") || "audit";
          if (action === "audit") {
            const audit = auditPageImages(html);
            return { ok: true, content: JSON.stringify({ action, audit, summary: summarizePageAssets(audit) }) };
          }
          if (action !== "rewrite") return { ok: false, content: "action must be audit or rewrite" };
          const requests = parseRequests(args.requests);
          const result = await resolvePageAssets(html, {
            workspace: ctx.workspace,
            requests,
            generator: deps.generator,
            ...(str(args, "outDir") ? { outDir: str(args, "outDir") } : {}),
            ...(str(args, "publicBase") ? { publicBase: str(args, "publicBase") } : {}),
            ...(str(args, "defaultAlt") ? { defaultAlt: str(args, "defaultAlt") } : {}),
          });
          let writtenPath: string | undefined;
          const outPath = str(args, "outPath").trim();
          if (outPath) {
            const file = resolveWrite(ctx.workspace, outPath);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, result.html, "utf8");
            writtenPath = outPath;
          }
          return {
            ok: true,
            content: JSON.stringify({
              action,
              html: result.html,
              assets: result.assets,
              replaced: result.replaced,
              altFilled: result.altFilled,
              audit: result.audit,
              finalAudit: result.finalAudit,
              ...(writtenPath ? { writtenPath } : {}),
              summary: summarizePageAssets(result.finalAudit),
            }),
          };
        } catch (error) {
          return { ok: false, content: `design_page_images failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}
