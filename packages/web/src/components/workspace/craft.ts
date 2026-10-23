'use client';

/**
 * Routing for the vendored Loam Craft editors (cr-03).
 *
 * One place maps a file type (or a MIME type, or an agent tool) to the Craft app
 * that owns it, and decides whether a file is an *editable* document at all or
 * just a preview. The Workspace registry, the auto-open decision and the
 * Workspace panel all read from here, so a file type can never resolve to two
 * different editors.
 *
 * The five editors are the Loam product keys from `craftBridge.ts`
 * (docs/sheets/slides/photo/design); the Loam names are what the user sees.
 */
import type { CraftApp } from '@/lib/craftBridge';
import type { WorkspaceKind } from './types';

/** Extensions each Craft app opens for editing. */
const EXT_BY_APP: Record<CraftApp, readonly string[]> = {
  docs: ['docx', 'docm', 'dotx', 'doc', 'odt', 'rtf'],
  sheets: ['xlsx', 'xlsm', 'xls', 'csv', 'ods'],
  slides: ['pptx', 'ppt', 'odp'],
  photo: ['psd', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'avif', 'bmp', 'gif'],
  design: ['idml', 'indd', 'pdf'],
};

/** MIME prefixes/suffixes each Craft app opens, for attachments that carry a MIME type. */
const MIME_BY_APP: Record<CraftApp, readonly (string | RegExp)[]> = {
  docs: [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml',
    'application/vnd.oasis.opendocument.text',
    'application/rtf',
    'text/rtf',
  ],
  sheets: [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml',
    'application/vnd.oasis.opendocument.spreadsheet',
    'text/csv',
  ],
  slides: [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml',
    'application/vnd.oasis.opendocument.presentation',
  ],
  photo: ['image/', 'application/vnd.adobe.photoshop'],
  design: ['application/pdf', 'application/indd', 'application/vnd.adobe.indesign'],
};

/** Extensions that are only ever shown as a preview (no editor opens them). */
const PREVIEW_ONLY_EXT = new Set(['indd']);

/** The extension of a path or file name, lowercased and without the leading dot. */
export function craftExtOf(pathOrName: string): string {
  const clean = (pathOrName ?? '').split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function matchesMime(rules: readonly (string | RegExp)[], mime: string): boolean {
  const value = (mime ?? '').toLowerCase();
  if (!value) return false;
  return rules.some((rule) => (typeof rule === 'string' ? value.startsWith(rule) : rule.test(value)));
}

/** True when the extension is one of the Craft apps' editable types. */
export function isCraftExtension(ext: string): boolean {
  return craftAppForExtension(ext) !== null;
}

/** Resolve the Craft app that edits a file extension, or null when none does. */
export function craftAppForExtension(ext: string): CraftApp | null {
  const value = (ext ?? '').replace(/^\./, '').toLowerCase();
  if (!value) return null;
  for (const [app, extensions] of Object.entries(EXT_BY_APP) as [CraftApp, readonly string[]][]) {
    if (extensions.includes(value)) return app;
  }
  return null;
}

/** Resolve the Craft app for an attachment's MIME type (a weaker signal than the name). */
export function craftAppForMime(mime: string): CraftApp | null {
  const value = (mime ?? '').toLowerCase();
  if (!value) return null;
  // Documents first: an `image/svg+xml` or a generic type must never win over a
  // document MIME, and `application/pdf` must stay with Loam Design.
  for (const [app, rules] of Object.entries(MIME_BY_APP) as Array<[CraftApp, ReadonlyArray<string | RegExp>]>) {
    if (app === 'photo') continue;
    if (matchesMime(rules, value)) return app;
  }
  if (matchesMime(MIME_BY_APP.photo, value)) return 'photo';
  return null;
}

/**
 * Resolve the Craft app for one attachment, preferring the file name over the
 * MIME type (a `.docx` mislabelled `application/octet-stream` is still a Docs file).
 */
export function craftAppForAttachment(name: string, mime?: string): CraftApp | null {
  const fromName = craftAppForExtension(craftExtOf(name));
  if (fromName) return fromName;
  return craftAppForMime(mime ?? '');
}

/**
 * True when this file type must only ever be previewed, not edited. `.indd` is
 * an upstream limitation (InDesign files cannot be opened by the app), so the
 * panel shows a notice and the media preview instead of a broken editor.
 */
export function isPreviewOnlyExt(ext: string): boolean {
  return PREVIEW_ONLY_EXT.has((ext ?? '').replace(/^\./, '').toLowerCase());
}

/**
 * A human-readable notice for a file type the Craft apps cannot open, in the
 * user's language. Returns null when the type is editable.
 */
export function unsupportedNoticeFor(pathOrName: string, locale: 'en' | 'ar' = 'en'): string | null {
  if (!isPreviewOnlyExt(craftExtOf(pathOrName))) return null;
  return locale === 'ar'
    ? 'هذا النوع من الملفات غير مدعوم للفتح في المحرّر؛ يُعرض معاينة فقط.'
    : 'This file type is not supported for editing; only a preview is shown.';
}

/**
 * The workspace editor kind to use for a file type: the Craft editor when a Craft
 * app edits it, otherwise the built-in editor (doc/sheet/slides) that owns it.
 * Returns null when no editor at all can open the file.
 */
export function editorKindForExtension(ext: string): WorkspaceKind | null {
  const app = craftAppForExtension(ext);
  if (app) return 'craft';
  switch ((ext ?? '').replace(/^\./, '').toLowerCase()) {
    case 'docx':
    case 'doc':
      return 'doc';
    case 'xlsx':
    case 'xls':
    case 'csv':
      return 'sheet';
    case 'pptx':
    case 'ppt':
      return 'slides';
    default:
      return null;
  }
}

/**
 * The Craft app implied by an agent tool call, or null. `office_craft` covers the
 * office engines only (cr-05); the layout/photo engines are selected by the file
 * extension instead.
 */
export function craftAppForTool(tool: string): CraftApp | null {
  const name = (tool ?? '').toLowerCase();
  // The generic office tool edits whatever file it is given, so it resolves per
  // extension (`decideWorkspaceOpen` keeps its own tool naming). A file-less call
  // has no app to open yet and returns null.
  if (name === 'office_craft' || name.startsWith('office_craft_')) return null;
  if (name === 'loam_design' || name === 'office_design') return 'design';
  return null;
}

/** True when the tool name belongs to the Craft/office family. */
export function isCraftToolName(tool: string): boolean {
  const name = (tool ?? '').toLowerCase();
  return name === 'office_craft' || name.startsWith('office_craft_') || name === 'office_edit' || name === 'loam_design';
}
