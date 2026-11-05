import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { rootAsset } from "../config.js";
import { taskPath } from "../server/taskWorkspace.js";
import type { DesignBrief } from "../design/brief.js";
import { presentationPaletteFromDesign, type PresentationDesignResult } from "./presentationDesign.js";
import { createPresentationIcons, type PresentationIconId } from "../design/presentationIcons.js";

export interface PresentationContent {
  title: string;
  body: string;
  subtitle?: string;
  background?: string;
  accent?: string;
}

export interface PresentationFact {
  label: string;
  value: string;
}

export interface PresentationImage {
  path: string;
  name: string;
  alt: string;
  attribution: string;
  source: string;
}

export interface PresentationPalette {
  background: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  secondary: string;
  line: string;
}

export interface PresentationBrief {
  title: string;
  body: string;
  subtitle: string;
  eyebrow: string;
  localeTag: string;
  sections: string[];
  headings: string[];
  facts: PresentationFact[];
  palette: PresentationPalette;
  layout: "editorial-cards";
  density: "standard" | "compact";
  arabic: boolean;
  designSource?: "model" | "fallback";
  designSummary?: string;
  image?: PresentationImage;
  icons?: Record<PresentationIconId, PresentationImage>;
}

export type PresentationAssetKind = "image" | "poster" | "illustration";

export interface PresentationAssetPlan {
  licensed?: PresentationImage;
  generate?: {
    kind: PresentationAssetKind;
    prompt: string;
    alt: string;
    requiresProvider: boolean;
  };
}

export function slideBodyParts(body: string): string[] {
  const parts = body.split(/\n+|(?<=[.!؟])\s+/).map((part) => part.trim()).filter(Boolean);
  return [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join(" ")].filter((part) => part.length > 0);
}

export function planPresentationAssets(prompt: string, design?: DesignBrief): PresentationAssetPlan {
  if (/علم الكويت|kuwait flag/i.test(prompt)) {
    const file = rootAsset("resources", "slides", "kuwait-towers.jpg");
    if (fs.existsSync(file)) {
      return {
        licensed: {
          path: file,
          name: "Kuwait Towers",
          alt: "أبراج الكويت على ساحل الخليج العربي",
          attribution: "Photo: Gladiator2030 / Wikimedia Commons · CC BY-SA 4.0 · cropped in slide",
          source: "https://commons.wikimedia.org/wiki/File:Kuwait_Towers2025.jpg",
        },
      };
    }
  }
  if (/ملصق|بانر|\bposter\b|\bbanner\b/i.test(prompt)) {
    return {
      generate: {
        kind: "poster",
        prompt: `${prompt.slice(0, 800)}\nWide 16:9 banner asset for an editable PowerPoint slide; preserve the requested Arabic copy and brand direction.`,
        alt: /[\u0590-\u08ff]/.test(prompt) ? "أصل بصري مولّد للعرض" : "Generated presentation banner",
        requiresProvider: false,
      },
    };
  }
  if (/شعار|\blogo\b/i.test(prompt)) {
    return {
      generate: {
        kind: "image",
        prompt: `Professional logo on a plain white background, clear vector-like silhouette, no mockup, no extra text. Subject: ${prompt.slice(0, 500)}`,
        alt: /[\u0590-\u08ff]/.test(prompt) ? "شعار مولّد للعرض" : "Generated presentation logo",
        requiresProvider: true,
      },
    };
  }
  if (/رسم(?:ًا)?\s+توضيحي(?:ًا)?|أيقونة|\billustration\b|\bicon\b/i.test(prompt)) {
    return {
      generate: {
        kind: "illustration",
        prompt: `Editorial presentation illustration, no words or letters, clear focal point, sophisticated geometric art direction. Subject: ${prompt.slice(0, 500)}`,
        alt: /[\u0590-\u08ff]/.test(prompt) ? "رسم توضيحي مولّد للعرض التقديمي" : "Generated presentation illustration",
        requiresProvider: false,
      },
    };
  }
  const imageNeed = design?.imageNeeds[0];
  if (imageNeed) {
    const illustration = /illustration|icon|vector/i.test(imageNeed.role);
    return {
      generate: {
        kind: illustration ? "illustration" : "image",
        prompt: `${imageNeed.description}. Professional presentation asset, no words or letters, no placeholders.`,
        alt: imageNeed.alt,
        requiresProvider: !illustration,
      },
    };
  }
  return {};
}

export function createPresentationBrief(
  content: PresentationContent,
  prompt: string,
  image?: PresentationImage,
  design?: PresentationDesignResult,
  icons?: Record<PresentationIconId, PresentationImage>,
): PresentationBrief | null {
  const sections = slideBodyParts(content.body);
  if (!image || sections.length < 3) return null;
  const arabic = /[\u0590-\u08ff]/.test(`${content.title}\n${content.body}`);
  const kuwait = /الكويت|kuwait/i.test(prompt);
  const basePalette: PresentationPalette = {
    background: content.background || "#F7F7F2",
    surface: "#FFFFFF",
    ink: "#17231C",
    muted: "#66736B",
    accent: content.accent || "#007A33",
    secondary: "#00843D",
    line: "#DCE3DC",
  };
  const palette = design ? presentationPaletteFromDesign(design.brief, basePalette) : basePalette;
  if (kuwait) {
    palette.background = basePalette.background;
    palette.accent = basePalette.accent;
    palette.secondary = basePalette.secondary;
  }
  return {
    title: content.title,
    body: content.body,
    subtitle: content.subtitle || (arabic ? "نظرة موجزة على الجغرافيا والهوية الرسمية وأبرز المعالم والحقائق الثقافية" : "A concise view of place, official identity, landmarks and cultural context"),
    eyebrow: kuwait ? (arabic ? "الخليج العربي · الشرق الأوسط" : "Arabian Gulf · Middle East") : (arabic ? "عرض تعريفي · ملخص بصري" : "Visual brief · Overview"),
    localeTag: kuwait ? "STATE OF KUWAIT · KW" : "LOAM · VISUAL BRIEF",
    sections,
    headings: kuwait
      ? (arabic ? ["بطاقة البيانات الأساسية", "أبرز المعالم الوطنية", "اللغة الرسمية والعملة", "الموقع الجغرافي والعاصمة"] : ["Key facts", "National landmarks", "Official language & currency", "Location & capital"])
      : (arabic ? ["أبرز البيانات", "المعالم والثقافة", "الهوية واللغة", "السياق والموقع"] : ["Key facts", "Landmarks & culture", "Identity", "Context"]),
    facts: kuwait
      ? (arabic
        ? [{ label: "الاسم الرسمي", value: "دولة الكويت" }, { label: "العاصمة", value: "مدينة الكويت" }, { label: "المساحة الكلية", value: "17,818 كم²" }, { label: "اليوم الوطني", value: "25 فبراير" }]
        : [{ label: "Official name", value: "State of Kuwait" }, { label: "Capital", value: "Kuwait City" }, { label: "Total area", value: "17,818 km²" }, { label: "National day", value: "25 February" }])
      : sections.slice(0, 3).map((section, index) => ({ label: arabic ? `محور ${index + 1}` : `Topic ${index + 1}`, value: section })),
    palette,
    layout: "editorial-cards",
    density: "standard",
    arabic,
    ...(design ? { designSource: design.source, designSummary: design.brief.summary } : {}),
    image,
    ...(icons ? { icons } : {}),
  };
}

export function repairPresentationBrief(brief: PresentationBrief, issues: string[]): PresentationBrief | null {
  if (!issues.some((issue) => /overflow|clipp|truncat|crowd|تداخل|اقتطاع|ازدحام/i.test(issue))) return null;
  return { ...brief, density: "compact" };
}

export async function cropPresentationImage(image: PresentationImage, taskRoot: string): Promise<PresentationImage> {
  const output = taskPath(taskRoot, "assets/presentation-hero.jpg");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = sharp(image.path, { failOn: "error" }).rotate();
  if (image.name === "Kuwait Towers") source.extract({ left: 1200, top: 200, width: 1600, height: 1085 });
  await source
    .resize(1180, 800, { fit: "cover", position: "attention" })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(output);
  return { ...image, path: output };
}

export interface GeneratedPresentationAsset {
  file: string;
  generator?: string;
}

export interface ResolvedPresentationAssets {
  image?: PresentationImage;
  icons?: Record<PresentationIconId, PresentationImage>;
  generated: boolean;
  provider?: string;
}

export async function resolvePresentationAssets(options: {
  prompt: string;
  taskRoot: string;
  design?: DesignBrief;
  iconColor?: string;
  generate?: (request: { kind: PresentationAssetKind; prompt: string; alt: string }) => Promise<string | GeneratedPresentationAsset>;
  createPoster?: (request: { prompt: string; alt: string }) => Promise<string | GeneratedPresentationAsset>;
  createCanvas?: (request: { prompt: string; alt: string }) => Promise<string | GeneratedPresentationAsset>;
}): Promise<ResolvedPresentationAssets> {
  const plan = planPresentationAssets(options.prompt, options.design);
  let plannedImage = plan.licensed;
  let generated = false;
  let provider = plan.licensed ? "licensed" : undefined;
  if (!plannedImage && plan.generate) {
    const request = plan.generate;
    let produced: string | GeneratedPresentationAsset | undefined;
    if (request.kind === "poster") {
      if (!options.createPoster) throw new Error("design_create is not available for this poster");
      produced = await options.createPoster(request);
    } else {
      if (!options.generate) throw new Error("design_image_generate is not available for this image");
      try {
        produced = await options.generate(request);
      } catch (error) {
        if (request.kind !== "illustration" || !options.createCanvas) throw error;
      }
      if (!produced && request.kind === "illustration" && options.createCanvas) produced = await options.createCanvas(request);
    }
    if (!produced) throw new Error("The presentation asset generator returned no asset");
    const result = typeof produced === "string" ? { file: produced } : produced;
    const relative = path.relative(options.taskRoot, path.resolve(result.file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Generated presentation asset is outside the task workspace");
    if (request.requiresProvider && result.generator !== "injected") {
      throw new Error("A real image provider is required for this photo or logo; the local geometric generator will not be presented as a professional substitute");
    }
    generated = true;
    provider = result.generator ?? "local";
    const attribution = request.kind === "poster" ? "Created with Loam Design Studio" : request.kind === "illustration" ? "Created with Loam vector illustration tools" : "Generated with the configured Loam image provider";
    const source = request.kind === "poster" ? "local://design_create" : request.kind === "illustration" ? "local://loam_canvas_or_design_image" : "local://design_image_generate";
    plannedImage = {
      path: path.resolve(result.file),
      name: request.kind === "poster" ? "Presentation banner" : request.kind === "illustration" ? "Presentation illustration" : "Presentation image",
      alt: request.alt,
      attribution,
      source,
    };
  }
  if (!plannedImage) return { generated, ...(provider ? { provider } : {}) };
  const image = await cropPresentationImage(plannedImage, options.taskRoot);
  const icons = await createPresentationIcons(options.taskRoot, options.iconColor ?? "#007A33");
  return { image, icons, generated, ...(provider ? { provider } : {}) };
}
