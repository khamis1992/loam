import { normalizeDesignBrief, type DesignBrief } from "../design/brief.js";
import type { Usage } from "./events.js";

export interface PresentationDesignPalette {
  background: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  secondary: string;
  line: string;
}

export interface PresentationDesignResult {
  brief: DesignBrief;
  source: "model" | "fallback";
  model: string;
  warnings: string[];
  usage: Usage;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

export function presentationContrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function colorForRoles(brief: DesignBrief, patterns: RegExp[], fallback: string): string {
  for (const pattern of patterns) {
    const color = brief.palette.find((entry) => pattern.test(entry.role));
    if (color && /^#[0-9a-f]{6}$/i.test(color.hex)) return color.hex.toUpperCase();
  }
  return fallback;
}

export function presentationPaletteFromDesign(brief: DesignBrief, fallback: PresentationDesignPalette): PresentationDesignPalette {
  const palette: PresentationDesignPalette = {
    background: colorForRoles(brief, [/^background$|^canvas/], fallback.background),
    surface: colorForRoles(brief, [/^surface$|^card/], fallback.surface),
    ink: colorForRoles(brief, [/^foreground$|^text$|^ink/], fallback.ink),
    muted: colorForRoles(brief, [/^muted$|^neutral$|secondary.*text/], fallback.muted),
    accent: colorForRoles(brief, [/^primary$|^accent$/], fallback.accent),
    secondary: colorForRoles(brief, [/^secondary$|brand.*alt/], fallback.secondary),
    line: colorForRoles(brief, [/^border$|^line$/], fallback.line),
  };
  const darkText = "#17231C";
  const lightText = "#F4F7F5";
  const lightBackground = presentationContrast(palette.background, darkText) >= presentationContrast(palette.background, lightText);
  if (presentationContrast(palette.ink, palette.background) < 4.5 || presentationContrast(palette.ink, palette.surface) < 4.5) {
    palette.ink = lightBackground ? darkText : lightText;
  }
  if (presentationContrast(palette.muted, palette.background) < 4.5 || presentationContrast(palette.muted, palette.surface) < 4.5) {
    palette.muted = lightBackground ? "#5F6B63" : "#C4CEC7";
  }
  if (presentationContrast(palette.accent, palette.surface) < 3) palette.accent = lightBackground ? fallback.accent : "#7BDAA4";
  if (presentationContrast(palette.secondary, palette.surface) < 3) palette.secondary = palette.accent;
  return palette;
}

export function parsePresentationDesignResult(content: string): PresentationDesignResult {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const rawUsage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage as Record<string, unknown> : {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rtl = typeof parsed.brief === "object" && parsed.brief !== null && (parsed.brief as { rtl?: boolean }).rtl === true;
  const normalized = normalizeDesignBrief(parsed.brief, "presentation", rtl);
  if (!normalized.ok) throw new Error(`design_brief is not usable for the presentation: ${normalized.errors.join("; ")}`);
  return {
    brief: normalized.brief,
    source: parsed.source === "model" ? "model" : "fallback",
    model: typeof parsed.model === "string" ? parsed.model : "unknown",
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [],
    usage: {
      promptTokens: number(rawUsage.promptTokens),
      completionTokens: number(rawUsage.completionTokens),
      durationMs: number(rawUsage.durationMs),
      ...(number(rawUsage.cachedTokens) > 0 ? { cachedTokens: number(rawUsage.cachedTokens) } : {}),
      ...(number(rawUsage.cacheWriteTokens) > 0 ? { cacheWriteTokens: number(rawUsage.cacheWriteTokens) } : {}),
    },
  };
}
