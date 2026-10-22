/**
 * Design Studio agent tools (clean-room implementation; behavioral spec only,
 * no ArtCraft code/assets/names).
 *
 * `design_create` fills a templated JSON layout with the stored brand kit and
 * the brief, renders a brand-consistent SVG into DATA_DIR/design/ (and copies
 * it into the task workspace when one is active), and routes the raster step
 * through an injected image generator when the supervisor wires one
 * (createDesignStudioTools({ imageGen })). Without injection the builtin SVG
 * renderer plus best-effort sharp PNG is used, so the tool always produces a
 * real, editable artifact. When a raster exists it is attached to the result
 * as `images` (bounded, PNG-verified) so the model can see the design it just
 * made instead of only being told where the file lives. `design_brand_kit_save`
 * lets a companion maintain the brand kit (name/colors/fonts/logo refs) the
 * same store the Design page uses.
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.js";
import { str } from "./registry.js";
import {
  DESIGN_TEMPLATES,
  generateDesign,
  getBrandKit,
  saveBrandKit,
  type BrandKit,
  type ImageGenFn,
} from "../server/designStudio.js";
import { taskPath } from "../server/taskWorkspace.js";

/** Largest raster we attach to the next model call (base64 grows it by ~4/3). */
const MAX_TOOL_IMAGE_BYTES = 4 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function templateExists(id: string): boolean {
  return DESIGN_TEMPLATES.some((t) => t.id === id);
}

/** Attach the rendered raster to the model call so it can see its own design.
 *  Returns undefined when the design has no PNG, the file vanished, or it is
 *  too large to send (an injected image tool is untrusted about size). */
function previewImage(record: { imageFile?: string }): string | undefined {
  if (!record.imageFile) return undefined;
  try {
    const stat = fs.statSync(record.imageFile);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TOOL_IMAGE_BYTES) return undefined;
    const buf = fs.readFileSync(record.imageFile);
    if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return undefined;
    return buf.toString("base64");
  } catch {
    return undefined;
  }
}

export function createDesignStudioTools(deps: { imageGen?: ImageGenFn } = {}): Tool[] {
  return [
    {
      name: "design_create",
      description:
        "Create a brand-consistent design from a short brief using the Design Studio surface. Picks (or takes) a JSON template — poster, banner, or social_card — fills it with the stored brand kit (colors/fonts/logo refs) and the brief copy, writes the spec + rendered SVG under the design store, and copies the SVG and raster into the active task workspace so they appear in the studio/library. Returns the design id, template, files, and a one-line preview of every filled slot; the rendered PNG is attached as an image so you can see the result. Manage brand kits via the Design page (/app/design) or the /api/design routes.",
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: "What to design, in plain language (e.g. 'Promote the Friday nutrition workshop, light and energetic')." },
          templateId: { type: "string", enum: DESIGN_TEMPLATES.map((t) => t.id), description: "Layout to use; auto-picked from the brief when omitted. An unknown id is an error, never a silent fallback." },
          brandKitId: { type: "string", description: "Brand kit to apply; the most recently saved kit is used when omitted. An unknown id is an error." },
        },
        required: ["brief"],
      },
      async run(args, ctx) {
        const brief = str(args, "brief").trim();
        if (!brief) return { ok: false, content: "brief is required" };
        const templateId = str(args, "templateId").trim();
        if (templateId && !templateExists(templateId)) {
          return { ok: false, content: `unknown design template: ${templateId} (choose one of ${DESIGN_TEMPLATES.map((t) => t.id).join(", ")})` };
        }
        const brandKitId = str(args, "brandKitId").trim();
        if (brandKitId && !getBrandKit(brandKitId)) {
          return { ok: false, content: `unknown brand kit: ${brandKitId}` };
        }
        try {
          const { record, spec } = await generateDesign(
            {
              brief,
              ...(templateId ? { templateId } : {}),
              ...(brandKitId ? { brandKitId } : {}),
            },
            deps,
          );
          const workspaceFiles: string[] = [];
          if (ctx.taskId) {
            // Workspace mirroring is best-effort; the design store is authoritative.
            try {
              const dir = taskPath(ctx.workspace, "design");
              fs.mkdirSync(dir, { recursive: true });
              const targets = [record.svgFile, record.imageFile].filter((f): f is string => Boolean(f));
              for (const source of targets) {
                const name = path.basename(source);
                fs.copyFileSync(source, path.join(dir, name));
                workspaceFiles.push(path.posix.join("design", name));
              }
            } catch {
              // The design store is authoritative; a mirror failure is not fatal.
            }
          }
          const preview = spec.slots
            .filter((s) => s.text || s.src)
            .map((s) => `${s.id}: ${(s.text ?? s.src ?? "").slice(0, 70)}`)
            .join(" | ");
          const image = previewImage(record);
          return {
            ok: true,
            content: JSON.stringify({
              designId: record.id,
              template: record.templateId,
              brandKit: record.brandName,
              generator: record.generator,
              specFile: record.specFile,
              svgFile: record.svgFile,
              imageFile: record.imageFile ?? null,
              workspaceFiles,
              preview,
              hint: "Open /app/design to tweak the brand kit or regenerate; preview via GET /api/design/outputs/<id>/image.",
            }),
            ...(image ? { images: [image] } : {}),
          };
        } catch (error) {
          return { ok: false, content: `design_create failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
    {
      name: "design_brand_kit_save",
      description:
        "Save or update the brand kit the Design Studio applies to generated designs: name, colors (primary/secondary/accent/background/text as #RRGGBB), fonts (heading/body), and logo references (paths or URLs). Omitting id creates a new kit. design_create always applies the most recent kit unless brandKitId is given.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing kit id to update; omit to create." },
          name: { type: "string" },
          colors: { type: "object", description: "{primary,secondary,accent,background,text} hex colors" },
          fonts: { type: "object", description: "{heading,body} font stacks" },
          logoRefs: { type: "array", items: { type: "string" }, description: "Logo file paths or URLs, up to 8." },
        },
        required: ["name"],
      },
      async run(args) {
        try {
          const id = str(args, "id").trim();
          const saved: BrandKit = saveBrandKit(
            { name: args.name, colors: args.colors, fonts: args.fonts, logoRefs: args.logoRefs },
            id ? id : undefined,
          );
          return { ok: true, content: JSON.stringify(saved) };
        } catch (error) {
          return { ok: false, content: `design_brand_kit_save failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];
}

export const DESIGN_STUDIO_TOOL_NAMES = ["design_create", "design_brand_kit_save"];
