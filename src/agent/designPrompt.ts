/**
 * Design-rules prompt section and the UI-intent classifier that gates it.
 *
 * The v0 gap analysis (see .cc-ref/V0_RE.md, §4) found that the single biggest
 * reason a generated interface looks good is that the prompt *enforces* an
 * opinionated design system: a tight colour discipline, a bounded type scale,
 * mobile-first layout, real assets, one icon set and hard accessibility rules.
 * This module owns that section, written in Loam's own voice, and the cheap
 * offline classifier that decides whether a request is a UI task at all.
 *
 * The section is deliberately injected only for UI intents (G12). It is not
 * part of the static master prompt, so a non-UI task never pays for it and a
 * UI task always gets the full rules.
 */

/**
 * The design-rules section. Full length on purpose: these are binding
 * constraints, and truncating them would remove the very rules that make the
 * output polished. Do not shorten.
 */
export const DESIGN_RULES_PROMPT: string = `## Design Rules (UI tasks only)

These rules apply to every task that produces a user interface: a web page, an app screen, a dashboard, a landing page, a component library or a design system. They are binding constraints, not suggestions. Follow them exactly. They are the difference between a product that looks considered and one that looks like a rough mock-up.

### 1. Start from a design brief
Fix the design direction before you write code. Use the design tools when they are available (for example \`design_brief\` or \`loam_design\`) to produce a palette, a type plan, a layout plan, an image plan and a mood. Never invent the visual concept while coding. If the user gave a direction, honour it; if not, choose the strongest option and proceed. The brief is the contract for the whole build, and the rest of this section exists to keep that contract honest.

### 2. Colour discipline
- Use semantic tokens only. Never hard-code a colour inside a component. Every colour comes from the design token layer: \`--background\`, \`--foreground\`, \`--card\`, \`--card-foreground\`, \`--popover\`, \`--popover-foreground\`, \`--primary\`, \`--primary-foreground\`, \`--secondary\`, \`--secondary-foreground\`, \`--muted\`, \`--muted-foreground\`, \`--accent\`, \`--accent-foreground\`, \`--destructive\`, \`--border\`, \`--input\`, \`--ring\`, the \`--chart-*\` series and the \`--sidebar*\` series.
- Keep the palette tight: at most five colours in use — one primary, two or three neutrals, and one or two accents. If a colour is not in the token set, it does not belong in the design.
- No gradients by default. Add one only when the brief explicitly asks for it, and then use at most three analogous stops.
- Any background override must be paired with a matching foreground override. Never place text on a colour you have not checked for contrast.
- Define tokens for light and dark, and set the background token on the root element. Every foreground/background pair must meet WCAG AA: 4.5:1 for body text and 3:1 for large text and UI borders.

### 3. Typography
- At most two type families. One for headings and one for body, or a single family with two weights. Never introduce a third display face.
- Body text is at least 14px with a line-height of 1.5 to 1.6. Use a modular scale for headings (for example 1.125 or 1.25 steps), never arbitrary jumps.
- Wire fonts through the platform's font loader and expose them as tokens (\`--font-sans\`, \`--font-heading\`, \`--font-mono\`). Never load a font by URL inside a component.
- Arabic and RTL: when the copy is Arabic, or in any right-to-left language, use a font that renders Arabic well. Pair an Arabic-capable face — IBM Plex Sans Arabic or Noto Kufi Arabic — with a Latin companion (Inter or IBM Plex Sans) for numbers and Latin runs. Set \`dir="rtl"\` on the document and use logical properties everywhere: \`margin-inline-start\` / \`margin-inline-end\`, \`padding-inline-start\` / \`padding-inline-end\`, \`text-align: start\`, and \`start\` / \`end\` for positioning. Never use physical \`left\` / \`right\` for layout that must flip. Test both LTR and RTL. Arabic glyphs sit lower and need slightly looser line-height (1.6 to 1.75) and enough diacritic space.
- Keep line length readable (roughly 45 to 75 characters), and let headings wrap on a narrow screen instead of overflowing.

### 4. Mobile-first layout
- Design for the narrowest breakpoint first (320 to 375px), then scale up. Every layout must work on a phone before it is made responsive.
- Layout priority: flex first for one-dimensional flow, grid for two-dimensional layouts, and absolute positioning only for true overlays such as modals, tooltips and floating controls.
- Use the framework's spacing scale and \`gap\` for spacing inside a container; reserve margins for separation between major sections. No arbitrary pixel values.
- Set a maximum content width and centre it. Keep section padding consistent from top to bottom of the page.
- Verify at mobile, tablet and desktop widths. No horizontal scroll, no clipped text, no content pushed off-screen.
- Touch targets are at least 44 by 44px, with adequate spacing between them.

### 5. Real imagery
- Use real images and real data. Never ship placeholder boxes, grey rectangles, lorem ipsum or "image coming soon" blocks.
- Prefer generated or supplied imagery over decorative graphics. Every image carries meaningful \`alt\` text that describes the content, not the filename.
- Never use decorative gradient blobs, floating circles or hand-drawn SVG illustrations as filler. If there is no image, design the section to work without one.
- Charts use the chart components and are bound to real numbers, with labelled axes and a legend where it helps.

### 6. Icons
- Icons come from a single set, at 16, 20 or 24px. Never mix icon families.
- Never use emoji as icons in the interface. Emoji may appear only inside user-authored text content, never as a UI affordance.

### 7. Accessibility
- Semantic HTML first: landmarks (\`header\`, \`main\`, \`nav\`, \`footer\`), real buttons for actions, real links for navigation, headings in order, and a skip link when the page is long.
- Every image has alt text; every form control has a visible label; icons-only controls have an accessible name.
- A visible focus ring is always present and is never removed. Keyboard navigation reaches every interactive element in a sensible order.
- Contrast is checked after any background override. Colour is never the only carrier of meaning.

### 8. Real copy
- Write real, specific, human copy. No lorem ipsum, no "this is a placeholder", no generic marketing filler.
- Match the user's language and register. Arabic copy is natural and idiomatic, not a literal translation of English.
- Labels name what they do. Empty states explain what is empty and what to do next. Error states state the problem and the fix.

### 9. Finish quality
- Before reporting done, verify the design actually holds: no raw colours, no more than five colours, no more than two fonts, no emoji icons, no missing alt text, no gradients outside the brief, and no horizontal overflow at 375px.
- Render the preview at mobile, tablet and desktop widths and inspect it. Fix overflow, misalignment and contrast failures before finishing.
- Ship something interesting, but never something ugly. A clean, well-spaced, well-typed page beats a busy one.`;

/**
 * Signals that a request is a UI task. Ordered from the most explicit to the
 * most contextual; a single hit is enough.
 */
const UI_INTENT_PATTERNS: readonly RegExp[] = [
  /\bui\b|\bux\b/i,
  /\buser interface\b|\bui\/ux\b/i,
  /\bfrontend\b|\bfront[- ]end\b/i,
  /\bweb ?(?:page|app|site|application)\b/i,
  /\bwebsite\b|\bweb site\b|\blanding ?page\b|\blanding\b/i,
  /\bdashboard\b|\badmin (?:panel|dashboard|console)\b|\bcontrol panel\b/i,
  /\bresponsive\b|\bmobile[- ]first\b|\bmobile ?app\b|\bnative app\b/i,
  /\breact component\b|\bvue component\b|\bsvelte component\b|\bcomponent library\b|\bdesign system\b|\bui kit\b|\bui components?\b/i,
  /\b(?:hero section|pricing page|checkout|portfolio|empty state|settings page|login page|sign ?up page|onboarding)\b/i,
  /\b(?:design|build|create|make|generate|style|restyle|redesign)\s+(?:me\s+|us\s+|a\s+|an\s+|the\s+)?(?:a\s+|an\s+|the\s+)?(?:ui|ux|interface|web ?(?:page|app|site)|website|landing page|dashboard|admin panel|app screen|page layout|component|screen)\b/i,
  /\b(?:page|screen|app|website|interface)\s+(?:design|layout|redesign|restyle)\b/i,
  /\barabic (?:page|website|app|ui|interface|layout)\b/i,
  /\brtl\b/i,
  /واجهة|واجهات|صفحة|صفحات|موقع|مواقع|تطبيق|تطبيقات|لوحة تحكم|لوحات تحكم|تصميم واجهة|تصميم صفحة|تصميم موقع|تصميم تطبيق|تصميم متجاوب|واجهة مستخدم|موبايل|متجاوب|عربي|rtl/i,
];

/**
 * Cheap offline classifier for a UI intent. Returns true when the request
 * clearly asks for a user interface, a web page or an app screen. Deliberately
 * conservative: it must not fire on ordinary coding, analysis or writing tasks.
 */
export function isUiIntent(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  for (const pattern of UI_INTENT_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

/** Exposed for tests and diagnostics: the section title used when injected. */
export const DESIGN_RULES_TITLE = "Design Rules (UI tasks only)";
