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
 * real, editable artifact. `design_brand_kit_save` lets a companion maintain
 * the brand kit (name/colors/fonts/logo refs) the same store the Design page
 * uses.
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.js";
import { str } from "./registry.js";
import {
  DESIGN_TEMPLATES,
  generateDesign,
  saveBrandKit,
  type ImageGenFn,
} from "../server/designStudio.js";
import { taskPath } from "../server/taskWorkspace.js";

export function createDesignStudioTools(deps: { imageGen?: ImageGenFn } = {}): Tool[] {
  return [
    {
      name: "design_create",
      description:
        "Create a brand-consistent design from a short brief using the Design Studio surface. Picks (or takes) a JSON template — poster, banner, or social_card — fills it with the stored brand kit (colors/fonts/logo refs) and the brief copy, writes the spec + rendered SVG under the design store, and copies the SVG into the active task workspace so it appears in the studio/library. Returns the design id, template, files, and a one-line preview of every filled slot. Manage brand kits via the Design page (/app/design) or the /api/design routes.",
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: "What to design, in plain language (e.g. 'Promote the Friday nutrition workshop, light and energetic')." },
          templateId: { type: "string", enum: DESIGN_TEMPLATES.map((t) => t.id), description: "Layout to use; auto-picked from the brief when omitted." },
          brandKitId: { type: "string", description: "Brand kit to apply; the most recently saved kit is used when omitted." },
        },
        required: ["brief"],
      },
      async run(args, ctx) {
        const brief = str(args, "brief").trim();
        if (!brief) return { ok: false, content: "brief is required" };
        try {
          const { record, spec } = await generateDesign(
            { brief, ...(str(args, "templateId") ? { templateId: str(args, "templateId") } : {}), ...(str(args, "brandKitId") ? { brandKitId: str(args, "brandKitId") } : {}) },
            deps,
          );
          let workspaceCopy = "";
          if (ctx.taskId) {
            try {
              const dir = taskPath(ctx.workspace, "design");
              fs.mkdirSync(dir, { recursive: true });
              const target = path.join(dir, `${record.id}.svg`);
              fs.copyFileSync(record.svgFile, target);
              workspaceCopy = path.posix.join("design", `${record.id}.svg`);
            } catch {
              // Workspace mirroring is best-effort; the design store is authoritative.
            }
          }
          const preview = spec.slots
            .filter((s) => s.text || s.src)
            .map((s) => `${s.id}: ${(s.text ?? s.src ?? "").slice(0, 70)}`)
            .join(" | ");
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
              workspaceCopy,
              preview,
              hint: "Open /app/design to tweak the brand kit or regenerate; preview via GET /api/design/outputs/<id>/image.",
            }),
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
          const id = str(args, "id");
          const saved = saveBrandKit(
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
