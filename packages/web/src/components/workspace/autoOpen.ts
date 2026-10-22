import type { ChatEvent, ChatMessageEvent, ServerAttachment, ToolUsedEvent } from '@shared/socket';
import { getEditorForPath } from './registry';
import type { WorkspaceKind } from './types';

export interface WorkspaceOpenTarget {
  /** Path of the file to select in the workspace panel, when the event named one. */
  path: string | null;
  /** Editor kind implied by the file extension; null for generic office/video tools. */
  kind: WorkspaceKind | null;
  /** For `loam-video`: the attached video to import into the studio automatically. */
  importPath?: string | null;
}

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#]|$)/i;

/** Tools that produce editable workspace artifacts even without a file extension match. */
export function isWorkspaceToolName(tool: string): boolean {
  const name = (tool ?? '').toLowerCase();
  return (
    name.startsWith('office_') ||
    name.startsWith('video') ||
    name.startsWith('docx') ||
    name.startsWith('xlsx') ||
    name.startsWith('pptx') ||
    name.startsWith('slides') ||
    name.startsWith('sheet') ||
    name.includes('_video') ||
    name.includes('docx') ||
    name.includes('xlsx') ||
    name.includes('pptx')
  );
}

/** The Loam Video studio tool (fc-03); routes to the `loam-video` panel. */
export function isVideoStudioTool(tool: string): boolean {
  const name = (tool ?? '').toLowerCase();
  return name === 'video_studio' || name.startsWith('video_studio_') || name === 'loam_video_studio';
}

/**
 * Edit/motion intent in the user's own words (Arabic + English). A bare mention
 * of "video" is not enough — the user must be asking for an edit.
 */
const VIDEO_EDIT_INTENT_RE = new RegExp(
  [
    // Arabic: montage, cut, edit, add, delete, merge, split, speed, music,
    // audio, title, text, subtitle, effect, transition, export, rotate, quality.
    'مونتاج',
    'قص',
    'قطع',
    'عدل',
    'تعديل',
    'تحرير',
    'أضف',
    'اضف',
    'إضافة',
    'اضافة',
    'حذف',
    'دمج',
    'تقسيم',
    'سرعة',
    'موسيقى',
    'صوت',
    'عنوان',
    'كتابة',
    'ترجمة',
    'تأثير',
    'انتقال',
    'تصدير',
    'حفظ',
    'تدوير',
    'جودة',
    'دقة',
    // English edit/motion verbs and nouns.
    '\\b(?:edit|cut|trim|montage|split|merge|add|delete|remove|music|audio|transition|effect|text|title|caption|subtitle|overlay|speed|export|render|enhance|color|stabilize|rotate|crop|resize|loop|reverse|mute|volume|zoom|fade)\\b',
  ].join('|'),
  'i',
);

export function hasVideoEditIntent(text: string): boolean {
  return VIDEO_EDIT_INTENT_RE.test(text ?? '');
}

function isVideoAttachment(attachment: ServerAttachment): boolean {
  if ((attachment.contentType ?? '').toLowerCase().startsWith('video/')) return true;
  const name = (attachment.path ?? attachment.filename ?? '').toLowerCase();
  return VIDEO_EXT_RE.test(name);
}

function messageText(event: ChatMessageEvent): string {
  if ((event.content ?? '').trim()) return event.content;
  return (event.contents ?? [])
    .map((c) => (c.type === 'text' ? c.value : ''))
    .filter(Boolean)
    .join(' ');
}

function videoAttachmentPath(event: ChatMessageEvent): string | null {
  const fromContents = (event.contents ?? [])
    .filter((c): c is { type: 'attachment'; attachment: ServerAttachment } => c.type === 'attachment')
    .map((c) => c.attachment);
  for (const attachment of [...(event.attachments ?? []), ...fromContents]) {
    if (isVideoAttachment(attachment)) return attachment.path ?? attachment.filename ?? null;
  }
  return null;
}

/**
 * Auto-open the Loam Video studio when the user attaches a video and asks for
 * an edit in the same message (Arabic or English intent).
 */
export function decideUserMessageOpen(event: ChatMessageEvent): WorkspaceOpenTarget | null {
  if (event.sender !== 'user') return null;
  const path = videoAttachmentPath(event);
  if (!path) return null;
  if (!hasVideoEditIntent(messageText(event))) return null;
  return { path, kind: 'loam-video', importPath: path };
}

function candidatePath(event: ToolUsedEvent): string | null {
  const sources: unknown[] = [event.argumentsDetail, event.detail];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    for (const key of ['path', 'file', 'filePath', 'outputPath', 'output', 'savePath', 'dest']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    const nested = rec['result'] ?? rec['output'];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      for (const key of ['path', 'file', 'filePath']) {
        const v = n[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  const text = [event.brief ?? '', event.description ?? ''].join(' ');
  const match = text.match(/[\w./\\-]+\.(mp4|mov|webm|mkv|docx|xlsx|pptx)(?=[\s,.;)]|$)/i);
  return match ? match[0] : null;
}

/** Decide whether a tool event should open the right panel on the Workspace tab. */
export function decideWorkspaceOpen(event: ToolUsedEvent): WorkspaceOpenTarget | null {
  if (isVideoStudioTool(event.tool)) {
    const path = candidatePath(event);
    return { path, kind: 'loam-video', importPath: path };
  }
  const path = candidatePath(event);
  if (path) {
    const editor = getEditorForPath(path);
    if (editor) return { path, kind: editor.kind };
    if (isWorkspaceToolName(event.tool)) return { path, kind: null };
    return null;
  }
  if (isWorkspaceToolName(event.tool)) return { path: null, kind: null };
  return null;
}

/** Latest event in the task that qualifies for workspace auto-open. */
export function latestWorkspaceDecision(
  events: ChatEvent[],
): { event: ChatEvent; target: WorkspaceOpenTarget } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'toolUsed') {
      const target = decideWorkspaceOpen(e);
      if (target) return { event: e, target };
    } else if (e.type === 'chat' && e.sender === 'user') {
      const target = decideUserMessageOpen(e);
      if (target) return { event: e, target };
    }
  }
  return null;
}
