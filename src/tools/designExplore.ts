/**
 * loam_design — build-phase design exploration + hero image generation.
 *
 * Exploration phase: derives 2-3 deterministic design directions (palette,
 * layout, hero concept) from the task brief. Hero phase: writes the hero
 * image for one direction through an injected image generator, defaulting
 * to the repo's existing loam_canvas tool (local vector SVG artwork). The
 * generator is a plain dependency so tests can substitute a mock.
 */

import { createLoamTools } from "./loam.js";
import { num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";

export type HeroImageGenerator = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface DesignExploreOptions {
  /** Injected image generator; defaults to the existing loam_canvas tool. */
  heroGenerator?: HeroImageGenerator;
}

export interface DesignPalette {
  background: string;
  surface: string;
  foreground: string;
  accent: string;
}

export interface DesignDirection {
  id: string;
  name: string;
  concept: string;
  palette: DesignPalette;
  layout: string;
  heroConcept: string;
}

export interface DesignExploreOutput {
  phase: "design-explore";
  brief: string;
  directions: DesignDirection[];
}

const HERO_PATH_SUFFIX = "-hero.svg";
const DEFAULT_COUNT = 3;
const MIN_COUNT = 1;
const MAX_COUNT = 3;

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lum = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const channel = (n: number) => {
    const value = lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * value).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

interface Archetype {
  id: string;
  name: string;
  concept: (brief: string, hue: number) => string;
  palette: (hue: number) => DesignPalette;
  layouts: string[];
  hero: (brief: string, palette: DesignPalette, hue: number) => string;
}

const ARCHETYPES: Archetype[] = [
  {
    id: "quiet-clarity",
    name: "Quiet Clarity",
    concept: (brief, hue) => `A calm light-first "${brief}" experience: generous whitespace, a soft ${hue}°-tinted pastel accent, and typography doing the talking. Reads as trustworthy and understated.`,
    palette: (hue) => ({
      background: hslToHex(hue, 30, 97),
      surface: hslToHex(hue, 25, 92),
      foreground: hslToHex(hue, 30, 16),
      accent: hslToHex(hue, 45, 42),
    }),
    layouts: [
      "single-column narrative with a centered hero banner above the fold",
      "split hero: left copy, right visual card, content in a narrow reading column",
      "three-step value strip under a compact top-facing hero",
    ],
    hero: (brief, p, hue) => `Full-bleed hero on the ${p.background} background with a large rounded organic shape in ${p.accent} (hue ${hue}°), short headline overlay spelling out ${brief}.`,
  },
  {
    id: "dark-foundry",
    name: "Dark Foundry",
    concept: (brief, hue) => `A high-contrast dark theme for "${brief}": near-black surfaces, one saturated ${hue}°-hue accent carrying the whole identity, and a dense, precise grid. Reads as technical and confident.`,
    palette: (hue) => ({
      background: hslToHex(hue, 20, 8),
      surface: hslToHex(hue, 18, 13),
      foreground: hslToHex(hue, 15, 94),
      accent: hslToHex(hue, 70, 58),
    }),
    layouts: [
      "edge-to-edge hero over a dark grid, features as cards below the fold",
      "left-rail navigation with a maximal full-height hero on the right",
      "bento-grid: hero tile proportional to its importance, secondary tiles 2×1",
    ],
    hero: (brief, p, hue) => `Dark hero: ${p.accent} gradient glow (hue ${hue}°) across a near-black field, headline for ${brief} set luminous ${p.foreground}, subtle noise texture.`,
  },
  {
    id: "warm-editorial",
    name: "Warm Editorial",
    concept: (brief, hue) => `An editorial voice for "${brief}": warm cream paper, earthy ${hue}°-tinted accent, serif display headings and a magazine-style rhythm. Reads as crafted and human.`,
    palette: (hue) => ({
      background: hslToHex(40, 55, 96),
      surface: hslToHex(35, 45, 90),
      foreground: hslToHex(30, 40, 18),
      accent: hslToHex(hue, 55, 38),
    }),
    layouts: [
      "editorial two-column: hero headline spanning both, articles staggered below",
      "poster-style centered hero with a rule line and short manifesto",
      "diagonal band separating hero from the content columns",
    ],
    hero: (brief, p, hue) => `Cream hero card framed by a thin ${p.accent} rule (hue ${hue}°), oversized serif headline for ${brief} with one flat ${p.accent} illustration block.`,
  },
];

function clampCount(value: number): number {
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(value)));
}

export function exploreDesigns(brief: string, count: number = DEFAULT_COUNT): DesignExploreOutput {
  const trimmed = brief.trim();
  if (trimmed.length < 4) throw new Error("brief must be at least 4 characters");
  const seed = hash32(trimmed.toLowerCase());
  const hue = seed % 360;
  const n = clampCount(Number.isFinite(count) ? count : DEFAULT_COUNT);
  const directions = ARCHETYPES.slice(0, n).map((archetype, index): DesignDirection => {
    const archetypeHue = (hue + index * 97) % 360;
    const palette = archetype.palette(archetypeHue);
    const layoutIndex = (seed + index * 2) % archetype.layouts.length;
    return {
      id: archetype.id,
      name: archetype.name,
      concept: archetype.concept(trimmed, archetypeHue),
      palette,
      layout: archetype.layouts[layoutIndex] ?? archetype.layouts[0]!,
      heroConcept: archetype.hero(trimmed, palette, archetypeHue),
    };
  });
  return { phase: "design-explore", brief: trimmed, directions };
}

function defaultHero(): HeroImageGenerator {
  const canvas = createLoamTools().find((tool) => tool.name === "loam_canvas");
  if (!canvas) throw new Error("loam_canvas is unavailable");
  return canvas.run.bind(canvas);
}

function resolveDirection(output: DesignExploreOutput, directionId: string): DesignDirection {
  const byId = output.directions.find((d) => d.id === directionId);
  return byId ?? output.directions[0] ?? (() => { throw new Error("no design directions produced"); })();
}

function defaultHeroTitle(brief: string): string {
  return brief.length <= 48 ? brief : `${brief.slice(0, 45)}…`;
}

export const DESIGN_EXPLORE_TOOL_NAME = "loam_design";
export const DESIGN_EXPLORE_TOOL_NAMES = [DESIGN_EXPLORE_TOOL_NAME];

export function createDesignExploreTools(options: DesignExploreOptions = {}): Tool[] {
  return [{
    name: DESIGN_EXPLORE_TOOL_NAME,
    description:
      "Designer tool for build briefs. action=explore derives 2-3 deterministic design directions from a brief: each returns an id, name, concept, palette (hex), layout and hero concept — show them to the user and implement the chosen one faithfully. action=generate_hero renders the hero image for one direction (path defaults to '<directionId>-hero.svg') through the local canvas generator; the returned JSON includes the saved path and the direction palette. Call explore first; keep palette and layout consistent with the chosen direction throughout the implementation.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["explore", "generate_hero"] },
        brief: { type: "string", description: "Full build brief in one sentence (what is being built, audience, mood)." },
        count: { type: "integer", minimum: MIN_COUNT, maximum: MAX_COUNT, default: DEFAULT_COUNT },
        directionId: { type: "string", description: "One of the explore ids; defaults to the first direction." },
        path: { type: "string", description: "Task-relative output path for the hero image (svg)." },
        title: { type: "string", description: "Hero headline; defaults to the brief." },
        subtitle: { type: "string", description: "Hero sub-line." },
      },
      required: ["action", "brief"],
    },
    async run(args, ctx): Promise<ToolResult> {
      const brief = str(args, "brief").trim();
      const action = str(args, "action");
      try {
        const output = exploreDesigns(brief, num(args, "count", DEFAULT_COUNT));
        if (action === "explore") {
          return { ok: true, content: JSON.stringify({ ...output, count: output.directions.length }) };
        }
        if (action !== "generate_hero") return { ok: false, content: "action must be explore or generate_hero" };
        const direction = resolveDirection(output, str(args, "directionId"));
        const generate = options.heroGenerator ?? defaultHero();
        const imageArgs: Record<string, unknown> = {
          path: str(args, "path") || `${direction.id}${HERO_PATH_SUFFIX}`,
          title: str(args, "title") || defaultHeroTitle(brief),
          subtitle: str(args, "subtitle") || `${direction.name} hero`,
          background: direction.palette.background,
          foreground: direction.palette.foreground,
          accent: direction.palette.accent,
        };
        const image = await generate(imageArgs, ctx);
        if (!image.ok) return { ok: false, content: `hero generation failed: ${image.content}` };
        let imagePath = "";
        try {
          imagePath = (JSON.parse(image.content) as Record<string, unknown>).path as string ?? "";
        } catch {
          imagePath = String(image.content);
        }
        return {
          ok: true,
          content: JSON.stringify({
            phase: "design-hero",
            direction: { id: direction.id, name: direction.name },
            palette: direction.palette,
            path: imagePath,
            ...(imageArgs.title ? { title: imageArgs.title } : {}),
          }),
        };
      } catch (error) {
        return { ok: false, content: `loam_design failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }];
}
