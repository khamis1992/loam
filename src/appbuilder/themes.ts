// src/appbuilder/themes.ts
import fs from "node:fs";
import path from "node:path";

export interface ThemePreset {
  id: "neutral" | "ocean" | "forest" | "sunset" | "plum" | "sand";
  label: string;
  /** Token overrides for :root. Keys are CSS custom property names without the leading "--". */
  light: Record<string, string>;
  /** Token overrides for .dark. */
  dark: Record<string, string>;
}

export const THEMES: readonly ThemePreset[] = [
  { id: "neutral", label: "Neutral", light: {}, dark: {} },
  {
    id: "ocean", label: "Ocean",
    light: { radius: "0.625rem", primary: "oklch(0.50 0.13 245)", "primary-foreground": "oklch(0.985 0 0)", ring: "oklch(0.62 0.12 245)", accent: "oklch(0.95 0.03 245)", "accent-foreground": "oklch(0.30 0.08 245)" },
    dark: { primary: "oklch(0.72 0.12 245)", "primary-foreground": "oklch(0.18 0.03 245)", ring: "oklch(0.55 0.10 245)", accent: "oklch(0.30 0.05 245)", "accent-foreground": "oklch(0.95 0.02 245)" },
  },
  {
    id: "forest", label: "Forest",
    light: { radius: "0.5rem", primary: "oklch(0.48 0.11 150)", "primary-foreground": "oklch(0.985 0 0)", ring: "oklch(0.60 0.10 150)", accent: "oklch(0.95 0.03 150)", "accent-foreground": "oklch(0.30 0.07 150)" },
    dark: { primary: "oklch(0.72 0.12 150)", "primary-foreground": "oklch(0.18 0.03 150)", ring: "oklch(0.55 0.09 150)", accent: "oklch(0.30 0.05 150)", "accent-foreground": "oklch(0.95 0.02 150)" },
  },
  {
    id: "sunset", label: "Sunset",
    light: { radius: "0.75rem", primary: "oklch(0.55 0.17 40)", "primary-foreground": "oklch(0.985 0 0)", ring: "oklch(0.66 0.15 40)", accent: "oklch(0.95 0.04 60)", "accent-foreground": "oklch(0.35 0.10 40)" },
    dark: { primary: "oklch(0.74 0.15 45)", "primary-foreground": "oklch(0.20 0.04 40)", ring: "oklch(0.58 0.13 40)", accent: "oklch(0.32 0.06 40)", "accent-foreground": "oklch(0.95 0.02 60)" },
  },
  {
    id: "plum", label: "Plum",
    light: { radius: "0.875rem", primary: "oklch(0.48 0.15 320)", "primary-foreground": "oklch(0.985 0 0)", ring: "oklch(0.62 0.13 320)", accent: "oklch(0.95 0.03 320)", "accent-foreground": "oklch(0.32 0.09 320)" },
    dark: { primary: "oklch(0.74 0.13 320)", "primary-foreground": "oklch(0.19 0.04 320)", ring: "oklch(0.56 0.11 320)", accent: "oklch(0.31 0.06 320)", "accent-foreground": "oklch(0.95 0.02 320)" },
  },
  {
    id: "sand", label: "Sand",
    light: { radius: "0.375rem", background: "oklch(0.985 0.008 85)", card: "oklch(0.995 0.005 85)", primary: "oklch(0.35 0.03 60)", "primary-foreground": "oklch(0.985 0.008 85)", ring: "oklch(0.60 0.04 60)", muted: "oklch(0.95 0.012 85)", accent: "oklch(0.94 0.02 75)", "accent-foreground": "oklch(0.30 0.03 60)", border: "oklch(0.90 0.015 85)", input: "oklch(0.90 0.015 85)" },
    dark: { background: "oklch(0.17 0.01 60)", card: "oklch(0.22 0.012 60)", primary: "oklch(0.88 0.03 80)", "primary-foreground": "oklch(0.22 0.02 60)", ring: "oklch(0.55 0.03 60)", muted: "oklch(0.27 0.012 60)", accent: "oklch(0.30 0.02 60)", "accent-foreground": "oklch(0.95 0.01 85)", border: "oklch(0.30 0.012 60)", input: "oklch(0.30 0.012 60)" },
  },
];

const START = "/* LOAM_THEME_START (written by Loam; edit with the Theme picker) */";
const END = "/* LOAM_THEME_END */";

function block(sel: string, vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`);
  return lines.length ? `${sel} {\n${lines.join("\n")}\n}\n` : "";
}

/** Idempotent: replaces the marked block or appends it. Neutral removes it. */
export function applyTheme(appDir: string, id: ThemePreset["id"]): void {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`unknown theme ${id}`);
  const cssPath = path.join(appDir, "src", "index.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const start = css.indexOf(START);
  const end = css.indexOf(END);
  const base = start >= 0 && end > start ? css.slice(0, start).trimEnd() + "\n" + css.slice(end + END.length).trimStart() : css;
  const body = block(":root", theme.light) + block(".dark", theme.dark);
  const next = id === "neutral" ? base : `${base.trimEnd()}\n\n${START}\n${body}${END}\n`;
  fs.writeFileSync(cssPath, next, "utf8");

  const designPath = path.join(appDir, "DESIGN.md");
  if (fs.existsSync(designPath)) {
    const doc = fs.readFileSync(designPath, "utf8");
    const line = `Theme: ${theme.label}`;
    const updated = /^Theme: .*$/m.test(doc)
      ? doc.replace(/^Theme: .*$/m, line)
      : doc.replace(/^## Tokens[^\n]*\n/m, (h) => `${h}${line}\n`);
    fs.writeFileSync(designPath, updated, "utf8");
  }
}
