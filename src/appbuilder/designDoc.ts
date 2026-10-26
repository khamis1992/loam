// src/appbuilder/designDoc.ts — DESIGN.md skeleton validator (MISSING §4.4.1)
export const DESIGN_HEADINGS = ["## Direction & Layout", "## Tokens", "## Patterns & States", "## Media"] as const;
export const DESIGN_MAX_BYTES = 6_000;

export interface DesignDocCheck { ok: boolean; problems: string[] }

export function checkDesignDoc(text: string): DesignDocCheck {
  const problems: string[] = [];
  let last = -1;
  for (const h of DESIGN_HEADINGS) {
    const i = text.indexOf(`${h}\n`);
    if (i < 0) problems.push(`missing heading "${h}"`);
    else if (i < last) problems.push(`heading "${h}" is out of order`);
    else last = i;
  }
  if (Buffer.byteLength(text, "utf8") > DESIGN_MAX_BYTES) problems.push(`DESIGN.md is over ${DESIGN_MAX_BYTES} bytes; keep each decision once`);
  if (!/oklch\(|#[0-9a-fA-F]{6}\b/.test(text)) problems.push("Tokens must give concrete colours (oklch(...) or #RRGGBB)");
  if (!/\b\d{2,4}px\b/.test(text)) problems.push("give concrete sizes in px (breakpoints, type sizes, spacing)");
  if (/```/.test(text)) problems.push("no code blocks in DESIGN.md");
  if (/\bsparkle|\bstar icon/i.test(text)) problems.push("Loam projects do not use sparkle or star icons");
  return { ok: problems.length === 0, problems };
}

/** The skeleton the scaffold phase writes when DESIGN.md is missing. */
export function designDocSkeleton(title: string): string {
  return [
    `# ${title} — design`,
    "",
    "## Direction & Layout",
    "One defining idea for the first screen (replace this line).",
    "",
    "## Tokens",
    "- Primary: oklch(0.55 0.15 260) — replace with the real colour",
    "- Base font and size scale in px",
    "Theme: Neutral",
    "",
    "## Patterns & States",
    "- Key component states (hover, active, disabled, empty)",
    "",
    "## Media",
    "- Breakpoints in px and what changes at each",
    "",
  ].join("\n");
}
