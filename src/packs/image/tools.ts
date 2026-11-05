import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { str } from "../../tools/registry.js";
import type { UiAssetGenerator } from "../../design/assets.js";
import { createLoamTools } from "../../tools/loam.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import type { PackProject } from "../types.js";
import { taskPath } from "../../server/taskWorkspace.js";

export interface ImagePackOptions {
  generator?: UiAssetGenerator;
}

function project(ctx: ToolContext): PackProject {
  const value = readPackProject(ctx.workspace, "loam-image");
  if (!value) throw new Error("image project is missing");
  return value;
}

function result(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
}

export function createImagePackTools(options: ImagePackOptions = {}): Tool[] {
  const generate = async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const prompt = str(args, "prompt").trim();
      if (!prompt) return { ok: false, content: "image prompt is required" };
      const format = str(args, "format", "svg");
      if (format !== "svg" && !options.generator) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: "image", formatsAvailableOffline: ["svg"] }) };
      const title = str(args, "title", prompt).slice(0, 120);
      const file = `uploads/${slug(title)}-${Date.now()}.${format === "jpeg" ? "jpg" : format}`;
      const absolute = taskPath(ctx.workspace, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (format === "svg") {
        const canvas = createLoamTools().find((tool) => tool.name === "loam_canvas");
        if (!canvas) throw new Error("local SVG generator is unavailable");
        const generated = await canvas.run({ path: file, title, subtitle: str(args, "subtitle"), background: str(args, "background", "#F7F3EA"), foreground: str(args, "foreground", "#17231C"), accent: str(args, "accent", "#187665") }, ctx);
        if (!generated.ok) return generated;
      } else {
        const generated = await options.generator!({
          prompt,
          alt: str(args, "alt", title),
          ...(typeof args.width === "number" ? { width: args.width } : {}),
          ...(typeof args.height === "number" ? { height: args.height } : {}),
        });
        fs.writeFileSync(absolute, generated.bytes);
      }
      if (!fs.existsSync(absolute) || fs.statSync(absolute).size < 100) throw new Error("generated image is empty");
      const value: PackProject = { projectId: ctx.taskId ?? "local-image", packId: "loam-image", revision: 0, items: [{ id: "image-1", state: "final", path: file }], data: { prompt, format } };
      writePackProject(ctx.workspace, value);
      return result({ path: file, bytes: fs.statSync(absolute).size, provider: format === "svg" ? "local-svg" : "configured-image-provider" });
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  };

  return [
    {
      name: "image_generate",
      description: "Create a real local SVG offline, or a PNG/JPEG/WebP through the configured BYO image provider. Never returns a placeholder or a fake cloud generation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string" },
          alt: { type: "string" },
          format: { type: "string", enum: ["svg", "png", "jpeg", "webp"] },
          width: { type: "integer", minimum: 16, maximum: 4096 },
          height: { type: "integer", minimum: 16, maximum: 4096 },
          background: { type: "string" },
          foreground: { type: "string" },
          accent: { type: "string" },
        },
        required: ["prompt"],
      },
      run: generate,
    },
    {
      name: "image_present",
      description: "Host-only gate that publishes the real generated image in the existing photo/design surface.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async run(_args, ctx) {
        const value = project(ctx);
        const artifacts = value.items.flatMap((item) => item.state === "final" && item.path ? [{ path: item.path, kind: "image" as const, title: item.id, mime: item.path.endsWith(".svg") ? "image/svg+xml" : item.path.endsWith(".png") ? "image/png" : item.path.endsWith(".webp") ? "image/webp" : "image/jpeg" }] : []);
        const presented = presentPackProject({ workspace: ctx.workspace, packId: "loam-image", kind: "image", artifacts, emit: ctx.emit });
        if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
        return result(presented);
      },
    },
  ];
}
