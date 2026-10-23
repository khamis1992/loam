/**
 * Neo N15 — Case Playbook: flow template schema and validation.
 *
 * Each flow template is a JSON file in `src/templates/flows/*.json` that
 * describes a reusable Loam flow: a prompt, a Loam mode, an effort level, and
 * an optional output type. The landing gallery ("Case Playbook") reads these
 * files, renders cards, and clicking "Try this flow" deep-links into the task
 * page with the composer pre-filled (prompt + mode + effort).
 *
 * Kept free of imports so it can be unit tested in isolation.
 */

export interface FlowTemplate {
  /** Stable slug used in the file name and deep-link URL. */
  id: string;
  /** Human-readable name shown on the card. */
  title: string;
  /** One-line description of what the flow produces. */
  description: string;
  /** The composer prompt text. */
  prompt: string;
  /** Loam mode id (ask/research/build/write/data/media/security/automate). */
  mode: string;
  /** Effort level: fast | max. */
  effort: 'fast' | 'max';
  /** Optional output type (auto/text/image/video/slides/website). */
  outputType?: 'auto' | 'text' | 'image' | 'video' | 'slides' | 'website';
  /** Optional emoji or icon glyph for the card. */
  icon?: string;
  /** Optional category for grouping cards on the landing UI. */
  category?: string;
}

export const FLOW_TEMPLATE_IDS = [
  'nutrio-dashboard',
  'nutrio-dashboard-arabic',
  'arabic-report',
  'landing-site',
  'product-slides',
  'data-analysis',
  'market-research',
  'code-review',
  'security-audit',
  'video-storyboard',
  'image-generation',
  'automation-workflow',
] as const;

export type FlowTemplateId = (typeof FLOW_TEMPLATE_IDS)[number];

export const FLOW_TEMPLATE_FILE_NAMES: Record<FlowTemplateId, string> = {
  'nutrio-dashboard': 'nutrio-dashboard.json',
  'nutrio-dashboard-arabic': 'nutrio-dashboard-arabic.json',
  'arabic-report': 'arabic-report.json',
  'landing-site': 'landing-site.json',
  'product-slides': 'product-slides.json',
  'data-analysis': 'data-analysis.json',
  'market-research': 'market-research.json',
  'code-review': 'code-review.json',
  'security-audit': 'security-audit.json',
  'video-storyboard': 'video-storyboard.json',
  'image-generation': 'image-generation.json',
  'automation-workflow': 'automation-workflow.json',
};

const VALID_MODES = ['ask', 'research', 'build', 'write', 'data', 'media', 'security', 'automate'] as const;
const VALID_EFFORTS = ['fast', 'max'] as const;
const VALID_OUTPUT_TYPES = ['auto', 'text', 'image', 'video', 'slides', 'website'] as const;

export function isValidFlowTemplate(value: unknown): value is FlowTemplate {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.title !== 'string' || v.title.length === 0) return false;
  if (typeof v.description !== 'string' || v.description.length === 0) return false;
  if (typeof v.prompt !== 'string' || v.prompt.length === 0) return false;
  if (typeof v.mode !== 'string' || !VALID_MODES.includes(v.mode as (typeof VALID_MODES)[number])) return false;
  if (typeof v.effort !== 'string' || !VALID_EFFORTS.includes(v.effort as (typeof VALID_EFFORTS)[number])) return false;
  if (v.outputType !== undefined && !VALID_OUTPUT_TYPES.includes(v.outputType as (typeof VALID_OUTPUT_TYPES)[number])) return false;
  if (v.icon !== undefined && typeof v.icon !== 'string') return false;
  if (v.category !== undefined && typeof v.category !== 'string') return false;
  return true;
}

export function validateFlowTemplates(templates: unknown[]): FlowTemplate[] {
  const valid: FlowTemplate[] = [];
  for (const t of templates) {
    if (isValidFlowTemplate(t)) valid.push(t);
  }
  return valid;
}
