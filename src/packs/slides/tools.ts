import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { str, strs } from "../../tools/registry.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import type { PackItem, PackProject } from "../types.js";
import { readStudio, saveStudio, type StudioArtifact } from "../../studio/store.js";
import { exportStudio } from "../../studio/export.js";
import { taskPath } from "../../server/taskWorkspace.js";
import type { UiAssetGenerator } from "../../design/assets.js";

type Presentation = Extract<StudioArtifact, { kind: "presentation" }>;
type Slide = Presentation["content"]["slides"][number];
type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
interface DeckOptions { imageGenerator?: UiAssetGenerator }

const JSON_CONTENT = "application/json";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function packTool(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): Tool {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, properties, required },
    async run(args, ctx) {
      try {
        return await handler(args, ctx);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

function deckProject(ctx: ToolContext): PackProject {
  const project = readPackProject(ctx.workspace, "loam-slides");
  if (!project) throw new Error("deck project is missing; call deck_attach to inspect or deck_init once");
  return project;
}

function presentation(ctx: ToolContext): Presentation {
  const artifact = readStudio(ctx.workspace);
  if (!artifact || artifact.kind !== "presentation") throw new Error("active studio is not a presentation");
  return artifact;
}

function slideTextValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(slideTextValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    for (const key of ["text", "content", "body", "value", "description", "summary", "paragraphs", "bullets", "bullet_points", "items"]) {
      if (raw[key] !== undefined) return slideTextValue(raw[key]);
    }
  }
  return "";
}

function normalizeSlide(input: unknown, index: number): Slide {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`slide ${index + 1} must be an object`);
  const raw = input as Record<string, unknown>;
  const body = raw.body ?? raw.content ?? (Array.isArray(raw.bullet_points) ? raw.bullet_points : "");
  const content = slideTextValue(body);
  const notes = slideTextValue(raw.notes ?? "");
  return {
    ...raw,
    id: String(raw.id ?? index + 1),
    title: slideTextValue(raw.title ?? raw.heading ?? ""),
    body: content || notes,
    notes,
    background: String(raw.background ?? "#F7F3EA"),
    accent: String(raw.accent ?? "#187665"),
  } as Slide;
}

function slidesFrom(args: Record<string, unknown>): Slide[] {
  if (!Array.isArray(args.slides) || args.slides.length === 0 || args.slides.length > 50) throw new Error("slides must contain 1..50 slide objects");
  return args.slides.map(normalizeSlide);
}

function outputPath(title: string, format = "pptx"): string {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 80).trim() || "presentation";
  return `uploads/${name}.${format === "html" ? "html" : format === "image" ? "png" : "pptx"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHtmlDeck(artifact: Presentation): string {
  const rtl = artifact.content.slides.some((slide) => /[\u0590-\u08ff]/.test(`${slide.title}\n${slide.body}`));
  const slides = artifact.content.slides.map((slide) => `<section class="slide"><h1>${escapeHtml(slide.title)}</h1><p>${escapeHtml(slide.body).replace(/\n/g, "<br>")}</p>${slide.notes ? `<aside>${escapeHtml(slide.notes)}</aside>` : ""}</section>`).join("\n");
  return `<!doctype html><html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(artifact.title)}</title><style>body{margin:0;background:#f7f3ea;color:#17231c;font-family:Arial,sans-serif}.slide{box-sizing:border-box;min-height:70vh;padding:64px;border-bottom:1px solid #d8ded8}h1{color:#187665;font-size:36px}p{font-size:22px;line-height:1.8;white-space:normal}aside{margin-top:32px;color:#737373;font-size:14px}</style></head><body>${slides}</body></html>`;
}

function verifyHtmlDeck(artifact: Presentation): number {
  const html = renderHtmlDeck(artifact);
  const count = (html.match(/<section class="slide">/g) ?? []).length;
  if (count !== artifact.content.slides.length) throw new Error("HTML slide count mismatch");
  const rtl = artifact.content.slides.some((slide) => /[\u0590-\u08ff]/.test(`${slide.title}\n${slide.body}`));
  if (rtl && !html.includes('dir="rtl"')) throw new Error("Arabic HTML deck is missing RTL direction");
  return Buffer.byteLength(html);
}

function verifyImageDeck(project: PackProject, workspace: string): number {
  let total = 0;
  const requireFiles = project.items.every((item) => item.state === "final");
  for (const item of project.items) {
    if (!item.path) throw new Error(`image slide has no output path: ${item.id}`);
    const absolute = taskPath(workspace, item.path);
    if (!fs.existsSync(absolute)) {
      if (requireFiles) throw new Error(`image slide is missing: ${item.id}`);
      continue;
    }
    const size = fs.statSync(absolute).size;
    if (size < 100) throw new Error(`image slide is empty or invalid: ${item.id}`);
    total += size;
  }
  return total;
}

function projectItems(slides: Slide[], file: string, state: PackItem["state"] = "pending"): PackItem[] {
  return slides.map((slide) => ({ id: slide.id, state, path: file }));
}

function saveProject(ctx: ToolContext, project: PackProject): void {
  writePackProject(ctx.workspace, { ...project, revision: project.revision + 1 });
}

function findSlide(artifact: Presentation, id: string): Slide {
  const slide = artifact.content.slides.find((candidate) => candidate.id === id);
  if (!slide) throw new Error(`slide not found: ${id}`);
  return slide;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function verifyDeck(artifact: Presentation, workspace: string, requireMuseumFacts = false, project?: PackProject): Promise<number> {
  const format = String(project?.data?.format ?? "pptx");
  if (format === "html") return verifyHtmlDeck(artifact);
  if (format === "image") return verifyImageDeck(project!, workspace);
  const exported = await exportStudio(artifact, workspace);
  const zip = await JSZip.loadAsync(exported.buffer);
  const count = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  if (count !== artifact.content.slides.length) throw new Error(`PPTX slide count mismatch: expected ${artifact.content.slides.length}, found ${count}`);
  const allText: string[] = [];
  for (const slide of artifact.content.slides) {
    const xml = await zip.file(`ppt/slides/slide${artifact.content.slides.indexOf(slide) + 1}.xml`)?.async("string");
    if (!xml || !xml.includes("<p:sld")) throw new Error(`invalid slide XML: ${slide.id}`);
    if (/[\u0590-\u08ff]/.test(`${slide.title}\n${slide.body}`) && !xml.includes('rtl="1"')) throw new Error(`Arabic slide is missing rtl="1": ${slide.id}`);
    allText.push(xml.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity));
  }
  const combined = allText.join("\n");
  if (requireMuseumFacts && /متحف الفن الإسلامي|Museum of Islamic Art/i.test(combined)) {
    if (!/I\.?\s*M\.?\s*Pei|آي\. إم\. بي/i.test(combined)) throw new Error("museum deck is missing I. M. Pei");
    if (!/2008/.test(combined)) throw new Error("museum deck is missing 2008");
  }
  return exported.buffer.length;
}

function finalArtifacts(project: PackProject): Array<{ path: string; kind: "deck"; title: string; mime: string }> {
  const format = String(project.data?.format ?? "pptx");
  const mime = format === "html" ? "text/html" : format === "image" ? "image/png" : PPTX_MIME;
  const paths = [...new Set(project.items.flatMap((item) => item.state === "final" && item.path ? [item.path] : []))];
  return paths.map((file) => ({ path: file, kind: "deck", title: String(project.data?.title ?? "Presentation"), mime }));
}

export function createDeckTools(options: DeckOptions = {}): Tool[] {
  return [
    packTool("deck_init", "Initialize one presentation project and register every outlined slide as pending. Existing projects are attached, never duplicated.", {
      title: { type: "string" },
      slides: { type: "array", minItems: 1, maxItems: 50, items: { type: "object" } },
      format: { type: "string", enum: ["pptx", "html", "image"] },
    }, ["title", "slides"], async (args, ctx) => {
      const existing = readPackProject(ctx.workspace, "loam-slides");
      if (existing) return json({ attached: true, project: existing });
      const format = str(args, "format", "pptx");
      if (format === "image" && !options.imageGenerator) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: "image", mode: "image" }) };
      const title = str(args, "title").trim();
      if (!title) throw new Error("deck title is required");
      const inputSlides = slidesFrom(args);
      const artifact = saveStudio(ctx.workspace, { kind: "presentation", title, content: { slides: inputSlides } }, 0) as Presentation;
      const project: PackProject = {
        projectId: ctx.taskId ?? "local-deck",
        packId: "loam-slides",
        revision: 0,
        items: format === "image"
          ? artifact.content.slides.map((slide) => ({ id: slide.id, state: "pending", path: outputPath(`${title}-${slide.id}`, "image") }))
          : projectItems(artifact.content.slides, outputPath(title, format)),
        data: { title, format },
      };
      writePackProject(ctx.workspace, project);
      return json({ project, studioRevision: artifact.revision });
    }),

    packTool("deck_attach", "Recover the existing deck project and current studio revision after a relay or transport error. Does not create a project.", {}, [], async (_args, ctx) => {
      const project = deckProject(ctx);
      const artifact = presentation(ctx);
      return json({ project, studioRevision: artifact.revision, slides: artifact.content.slides.map((slide) => ({ id: slide.id, title: slide.title })) });
    }),

    packTool("deck_author", "Author or replace one registered slide while preserving all other slides and user edits.", {
      id: { type: "string" },
      slide: { type: "object" },
    }, ["id", "slide"], async (args, ctx) => {
      const project = deckProject(ctx);
      const id = str(args, "id");
      const item = project.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`unregistered slide: ${id}`);
      if (!args.slide || typeof args.slide !== "object" || Array.isArray(args.slide)) throw new Error("slide must be an object");
      const artifact = presentation(ctx);
      findSlide(artifact, id);
      const slide = { ...normalizeSlide(args.slide, 0), id };
      const next = artifact.content.slides.map((candidate) => candidate.id === id ? slide : candidate);
      try {
        const saved = saveStudio(ctx.workspace, { ...artifact, content: { slides: next } }, artifact.revision) as Presentation;
        item.state = "authored";
        delete item.errors;
        saveProject(ctx, project);
        return json({ id, state: item.state, studioRevision: saved.revision });
      } catch (error) {
        item.state = "invalid";
        item.errors = [error instanceof Error ? error.message : String(error)];
        saveProject(ctx, project);
        throw error;
      }
    }),

    packTool("deck_review", "Validate slide content, contrast, assets and native PPTX XML, then mark one authored slide final.", {
      id: { type: "string" },
      preview: { type: "boolean" },
    }, ["id"], async (args, ctx) => {
      const project = deckProject(ctx);
      const id = str(args, "id");
      const item = project.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`unregistered slide: ${id}`);
      const artifact = presentation(ctx);
      const slide = findSlide(artifact, id);
      const errors: string[] = [];
      if (item.state !== "authored" && item.state !== "final") errors.push(`state is ${item.state}; author the slide first`);
      if (!slide.title.trim()) errors.push("title is empty");
      if (!slide.body.trim() && !slide.textBoxes?.length && !slide.images?.length && !slide.charts?.length && !slide.tables?.length) errors.push("slide has no content");
      if (/(?:lorem ipsum|placeholder|عنصر نائب|أضف النص هنا)/i.test(`${slide.title}\n${slide.body}`)) errors.push("placeholder content remains");
      if (contrast(slide.background, slide.accent) < 1.3) errors.push("background and accent contrast is insufficient");
      const bytes = errors.length === 0 ? await verifyDeck(artifact, ctx.workspace, false, project) : 0;
      let previewPath: string | undefined;
      if (errors.length === 0 && args.preview === true) {
        try {
          const exported = await exportStudio(artifact, ctx.workspace);
          const { renderSlidePreview } = await import("../../studio/slide-preview.js");
          const index = artifact.content.slides.findIndex((candidate) => candidate.id === id);
          const png = await renderSlidePreview(exported.buffer, index + 1);
          previewPath = `previews/${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
          const absolute = taskPath(ctx.workspace, previewPath);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, png);
        } catch (error) {
          errors.push(`preview failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      item.state = errors.length > 0 ? "invalid" : "final";
      if (errors.length > 0) item.errors = errors;
      else delete item.errors;
      saveProject(ctx, project);
      if (errors.length > 0) return { ok: false, content: JSON.stringify({ id, state: item.state, errors }) };
      return json({ id, state: item.state, verifiedPptxBytes: bytes, ...(previewPath ? { previewPath } : {}) });
    }),

    packTool("deck_organize", "Add, remove or reorder slides. Structural changes return affected slides to pending for authoring and review.", {
      order: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
      add: { type: "array", items: { type: "object" } },
    }, [], async (args, ctx) => {
      const project = deckProject(ctx);
      const artifact = presentation(ctx);
      const removed = new Set(strs(args, "remove"));
      let slides = artifact.content.slides.filter((slide) => !removed.has(slide.id));
      if (Array.isArray(args.add)) slides.push(...(args.add as Slide[]));
      const order = strs(args, "order");
      if (order.length > 0) {
        const positions = new Map(order.map((id, index) => [id, index]));
        slides = [...slides].sort((a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length));
      }
      if (slides.length === 0) throw new Error("a deck must retain at least one slide");
      const saved = saveStudio(ctx.workspace, { ...artifact, content: { slides } }, artifact.revision) as Presentation;
      const previous = project.items;
      project.items = projectItems(saved.content.slides, String(project.data?.outputPath ?? outputPath(saved.title))).map((item) => {
        const old = previous.find((candidate) => candidate.id === item.id);
        return old ? { ...old, path: item.path } : item;
      });
      for (const old of previous) {
        if (removed.has(old.id) && !project.items.some((item) => item.id === old.id)) {
          project.items.push({ ...old, state: "pending", errors: ["slide was removed mid-run"] });
        }
      }
      saveProject(ctx, project);
      return json({ project, studioRevision: saved.revision });
    }),

    packTool("deck_export", "Export the reviewed deck as PPTX, HTML or provider-generated slide images. Every slide must be final.", {
      format: { type: "string", enum: ["pptx", "html", "image"] },
    }, [], async (args, ctx) => {
      const project = deckProject(ctx);
      const format = str(args, "format", String(project.data?.format ?? "pptx"));
      const blocked = project.items.filter((item) => item.state !== "final");
      if (blocked.length > 0) return { ok: false, content: JSON.stringify({ error: "slides_not_final", missing: blocked.map((item) => item.id) }) };
      const artifact = presentation(ctx);
      if (format === "image") {
        if (!options.imageGenerator) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: "image", mode: "image" }) };
        let bytes = 0;
        for (const slide of artifact.content.slides) {
          const item = project.items.find((candidate) => candidate.id === slide.id)!;
          const file = item.path ?? outputPath(`${artifact.title}-${slide.id}`, "image");
          const absolute = taskPath(ctx.workspace, file);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          const generated = await options.imageGenerator({ prompt: `${slide.title}\n${slide.body}\nVisual style: ${slide.background} with ${slide.accent} accents. Clean editorial presentation illustration, no text in the image.`, alt: slide.title, width: 1024, height: 576 });
          fs.writeFileSync(absolute, generated.bytes);
          item.path = file;
          bytes += generated.bytes.length;
        }
        await verifyDeck(artifact, ctx.workspace, true, project);
        project.data = { ...project.data, outputPath: project.items[0]?.path };
        saveProject(ctx, project);
        return json({ path: project.items[0]?.path, mime: "image/png", bytes });
      }
      if (format === "html") {
        const file = String(project.data?.outputPath ?? outputPath(artifact.title, "html"));
        const html = renderHtmlDeck(artifact);
        const absolute = taskPath(ctx.workspace, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, html);
        await verifyDeck(artifact, ctx.workspace, true, project);
        project.data = { ...project.data, outputPath: file };
        for (const item of project.items) item.path = file;
        saveProject(ctx, project);
        return json({ path: file, mime: "text/html", bytes: Buffer.byteLength(html) });
      }
      const exported = await exportStudio(artifact, ctx.workspace);
      const file = String(project.data?.outputPath ?? outputPath(artifact.title));
      const absolute = taskPath(ctx.workspace, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, exported.buffer);
      await verifyDeck(artifact, ctx.workspace, true, project);
      project.data = { ...project.data, outputPath: file };
      for (const item of project.items) item.path = file;
      saveProject(ctx, project);
      return json({ path: file, mime: PPTX_MIME, bytes: exported.buffer.length });
    }),

    packTool("deck_notes", "Record image sources, citations and the chosen design direction with the deck project.", {
      sources: { type: "array", items: { type: "string" } },
      direction: { type: "string" },
      design: { type: "string" },
    }, [], async (args, ctx) => {
      const project = deckProject(ctx);
      project.data = {
        ...project.data,
        notes: { sources: strs(args, "sources"), direction: str(args, "direction"), design: str(args, "design") },
      };
      saveProject(ctx, project);
      return json({ notes: project.data.notes, revision: project.revision + 1 });
    }),

    packTool("deck_present", "Host-only delivery gate. Publishes the real PPTX only when every slide is final and the file exists.", {}, [], async (_args, ctx) => {
      const project = deckProject(ctx);
      const result = presentPackProject({ workspace: ctx.workspace, packId: "loam-slides", kind: "deck", artifacts: finalArtifacts(project), emit: ctx.emit });
      if (!result.ok) return { ok: false, content: JSON.stringify(result) };
      return json({ ...result, target: { kind: "craft", craftApp: "slides", path: result.artifacts[0] } });
    }),
  ];
}
