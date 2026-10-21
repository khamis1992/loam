// NOTICE: The launcher concept below (a tab of in-app studio tool cards that open the
// task workspace per kind) follows the ARTCRAFT_ANALYSIS section 7 (S-LAUNCHER) design
// reference. This is an original clean-room TypeScript implementation; no ArtCraft code,
// brand, or assets are used.
//
// Static fallback list + normalization for an optional CR1 GET /api/studio tool list.
// label/subtitle/prompt fields hold i18n keys (rendered with t() by the page); plain
// strings coming from the API pass through t() unchanged.

export type StudioToolKind = 'video' | 'document' | 'spreadsheet' | 'presentation' | 'design';

export interface StudioTool {
  id: string;
  kind: StudioToolKind;
  label: string;
  subtitle: string;
  prompt: string;
  loamMode: string;
}

const MODE_BY_KIND: Record<StudioToolKind, string> = {
  video: 'media',
  design: 'media',
  document: 'write',
  presentation: 'write',
  spreadsheet: 'data',
};

const TOOL_KINDS: StudioToolKind[] = ['video', 'document', 'spreadsheet', 'presentation', 'design'];

export const STATIC_STUDIO_TOOLS: StudioTool[] = [
  { id: 'video', kind: 'video', label: 'Video', subtitle: 'Edit and render videos', prompt: 'Videos starter', loamMode: MODE_BY_KIND.video },
  { id: 'document', kind: 'document', label: 'Docs', subtitle: 'Draft and export documents', prompt: 'Docs starter', loamMode: MODE_BY_KIND.document },
  { id: 'spreadsheet', kind: 'spreadsheet', label: 'Sheets', subtitle: 'Analyze and edit spreadsheets', prompt: 'Sheets starter', loamMode: MODE_BY_KIND.spreadsheet },
  { id: 'presentation', kind: 'presentation', label: 'Slides', subtitle: 'Build presentation decks', prompt: 'Slides starter', loamMode: MODE_BY_KIND.presentation },
  { id: 'design', kind: 'design', label: 'Design', subtitle: 'Create images and visuals', prompt: 'Images starter', loamMode: MODE_BY_KIND.design },
];

function isToolKind(value: unknown): value is StudioToolKind {
  return typeof value === 'string' && TOOL_KINDS.includes(value as StudioToolKind);
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const DEFAULTS_BY_KIND: Record<StudioToolKind, StudioTool> = Object.fromEntries(
  STATIC_STUDIO_TOOLS.map((tool) => [tool.kind, tool]),
) as Record<StudioToolKind, StudioTool>;

/**
 * Normalize a CR1 `GET /api/studio` payload shaped `{ tools: [{ kind, id?, name?, subtitle?, prompt?, mode? }] }`.
 * Entries without one of the known studio kinds are ignored; a payload with no usable
 * entries returns null so callers fall back to the static list.
 */
export function pickStudioTools(payload: unknown): StudioTool[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawTools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return null;
  const out: StudioTool[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kind = entry.kind;
    if (!isToolKind(kind)) continue;
    const fallback = DEFAULTS_BY_KIND[kind];
    out.push({
      id: trimmedString(entry.id) ?? kind,
      kind,
      label: trimmedString(entry.name) ?? trimmedString(entry.label) ?? fallback.label,
      subtitle: trimmedString(entry.subtitle) ?? fallback.subtitle,
      prompt: trimmedString(entry.prompt) ?? fallback.prompt,
      loamMode: trimmedString(entry.mode) ?? trimmedString(entry.loamMode) ?? MODE_BY_KIND[kind],
    });
  }
  return out.length > 0 ? out : null;
}
