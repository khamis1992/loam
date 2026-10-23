import type { ChatEvent, ChatMessageEvent, ServerAttachment, ToolUsedEvent } from '@shared/socket';
import { getEditorForPath } from './registry';
import type { WorkspaceKind } from './types';
import { craftAppForExtension, craftExtOf, craftAppForTool, isCraftToolName } from './craft';

export interface WorkspaceOpenTarget {
  /** Path of the file to select in the workspace panel, when the event named one. */
  path: string | null;
  /** Editor kind implied by the file extension; null for generic office/video tools. */
  kind: WorkspaceKind | null;
  /** For `loam-video`: the attached video to import into the studio automatically. */
  importPath?: string | null;
  /**
   * For `craft`: which Loam Craft app owns the file (docs/sheets/slides/photo/design).
   * Null for generic craft/office tools without a file to resolve.
   */
  craftApp?: string | null;
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
    name.includes('pptx') ||
    name.includes('craft') ||
    name.includes('photo') ||
    name.includes('design')
  );
}

/** The Loam Video studio tool (fc-03); routes to the `loam-video` panel. */
export function isVideoStudioTool(tool: string): boolean {
  const name = (tool ?? '').toLowerCase();
  return name === 'video_studio' || name.startsWith('video_studio_') || name === 'loam_video_studio';
}

/**
 * Edit intent in the user's own words (Arabic + English) for a document, sheet,
 * slide deck, image or layout. A bare mention of the file is not enough: the user
 * must be asking for a change, so a question about an attachment opens nothing.
 */
const CRAFT_EDIT_INTENT_RE = new RegExp(
  [
    // Arabic: edit verbs, formatting, layout and photo vocabulary.
    'عدل',
    'عدّل',
    'تعديل',
    'تحرير',
    'تنسيق',
    'نسخ',
    'نسّق',
    'صمّم',
    'صمم',
    'تصميم',
    'أضف',
    'اضف',
    'إضافة',
    'اضافة',
    'أدرج',
    'ادرج',
    'ادراج',
    'إدراج',
    'حذف',
    'احذف',
    'غير',
    'غيّر',
    'غيرر',
    'رتب',
    'رتّب',
    'رتبّر',
    'حرّر',
    'حرر',
    'أعد',
    'اعد',
    'إعادة',
    'اعادة',
    'صحح',
    'صحّح',
    'أصحح',
    'اصحح',
    'احفر',
    'اقتصص',
    'قصّ',
    'قص',
    'غي',
    'دمج',
    'دمجّ',
    'تقسيم',
    'لوّن',
    'لون',
    'تلوين',
    'تأثير',
    'تأثيرات',
    'فلتر',
    'فلاتر',
    'دقة',
    'جودة',
    'أبعاد',
    'ابعاد',
    'حجم',
    'تدوير',
    'دوران',
    'استبدل',
    'بدّل',
    'بدل',
    'ترميم',
    'ازالة',
    'إزالة',
    'ترانسبار',
    'خلفية',
    'خطوط',
    'خط',
    'جدول',
    'جداول',
    'رسم',
    'رسوم',
    'شكل',
    'أشكال',
    'اشكال',
    'طباعة',
    'تصدير',
    'حفظ',
    'مخطط',
    'صفحة',
    'شريحة',
    'شرائح',
    'مستند',
    'وثيقة',
    'عرض',
    'تقديمي',
    'بيانات',
    'معادلات',
    'خلية',
    'خلايا',
    // English: edit verbs and nouns, including layout/photo vocabulary.
    '\\b(?:edit|modify|format|fix|change|update|reformat|restyle|copy|paste|duplicate|'
      + 'add|insert|append|remove|delete|replace|rearrange|reorder|sort|filter|'
      + 'design|layout|retouch|crop|resize|rotate|flip|scale|zoom|enhance|color|colour|'
      + 'tone|brightness|contrast|saturation|blur|sharpen|mask|filter|effect|overlay|'
      + 'background|gradient|border|shadow|opacity|blend|'
      + 'typography|typeface|font|heading|paragraph|spacing|margin|align|indent|'
      + 'table|chart|graph|diagram|shape|icon|logo|'
      + 'slide|deck|presentation|document|doc|sheet|spreadsheet|workbook|'
      + 'formula|cell|range|column|row|'
      + 'export|save|download|redesign)\\b',
  ].join('|'),
  'i',
);

export function hasCraftEditIntent(text: string): boolean {
  return CRAFT_EDIT_INTENT_RE.test(text ?? '');
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

/** True when the attachment is one of the Craft apps' document/photo/layout types. */
function isCraftAttachment(attachment: ServerAttachment): boolean {
  const app = craftAppForExtension(craftExtOf(attachment.path ?? attachment.filename ?? ''));
  if (app) return true;
  const mime = (attachment.contentType ?? '').toLowerCase();
  return /(wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint|opendocument|image\/|application\/pdf)/.test(mime);
}

function messageText(event: ChatMessageEvent): string {
  if ((event.content ?? '').trim()) return event.content;
  return (event.contents ?? [])
    .map((c) => (c.type === 'text' ? c.value : ''))
    .filter(Boolean)
    .join(' ');
}

function messageAttachments(event: ChatMessageEvent): ServerAttachment[] {
  const fromContents = (event.contents ?? [])
    .filter((c): c is { type: 'attachment'; attachment: ServerAttachment } => c.type === 'attachment')
    .map((c) => c.attachment);
  return [...(event.attachments ?? []), ...fromContents];
}

function attachmentPath(attachment: ServerAttachment): string | null {
  return attachment.path ?? attachment.filename ?? null;
}

function videoAttachmentPath(event: ChatMessageEvent): string | null {
  for (const attachment of messageAttachments(event)) {
    if (isVideoAttachment(attachment)) return attachmentPath(attachment);
  }
  return null;
}

/**
 * The craft attachment a user edit intent refers to, or null. A video is never a
 * craft attachment (it belongs to the Loam Video studio), and a document-like
 * file without an edit intent must keep its current behaviour.
 */
function craftAttachmentPath(event: ChatMessageEvent): string | null {
  const attachments = messageAttachments(event);
  for (const attachment of attachments) {
    if (isVideoAttachment(attachment)) continue;
    if (isCraftAttachment(attachment)) return attachmentPath(attachment);
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
  if (path) {
    if (!hasVideoEditIntent(messageText(event))) return null;
    return { path, kind: 'loam-video', importPath: path };
  }
  // Craft apps: the user attached a document/photo/layout and asked for a change.
  const craftPath = craftAttachmentPath(event);
  if (craftPath && hasCraftEditIntent(messageText(event))) {
    return { path: craftPath, kind: 'craft', craftApp: craftAppForExtension(craftExtOf(craftPath)) };
  }
  return null;
}

const OFFICE_PATH_RE = /[\w./\\-]+\.(docx|docm|dotx|doc|odt|rtf|xlsx|xlsm|xls|csv|ods|pptx|ppt|odp|psd|png|jpg|jpeg|webp|tif|tiff|heic|avif|bmp|gif|idml|indd|pdf|mp4|mov|webm|mkv)(?=[\s,.;)]|$)/i;

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
  const match = text.match(OFFICE_PATH_RE);
  return match ? match[0] : null;
}

/** Resolve the craft app for a path, or the one an explicit tool named. */
function craftAppForTarget(tool: string, path: string | null): string | null {
  if (path) return craftAppForExtension(craftExtOf(path));
  return craftAppForTool(tool);
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
    if (editor) {
      const target: WorkspaceOpenTarget = { path, kind: editor.kind };
      if (editor.kind === 'craft') target.craftApp = craftAppForTarget(event.tool, path);
      return target;
    }
    if (isWorkspaceToolName(event.tool)) return { path, kind: null };
    return null;
  }
  if (isWorkspaceToolName(event.tool)) {
    const target: WorkspaceOpenTarget = { path: null, kind: null };
    // A craft/office tool without a path still belongs on the Workspace tab; the
    // panel lists the task's files and the user opens one manually.
    if (isCraftToolName(event.tool)) target.kind = 'craft';
    return target;
  }
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
