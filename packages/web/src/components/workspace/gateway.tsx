'use client';

/**
 * The editor gateway (UI side): the pieces the Workspace panel renders around the
 * automatic editor choice. Resolution itself lives in `registry.ts`
 * (override > best-generation extension match > declared kind); this module adds
 *
 * - `EditorOverrideMenu`: the small «فتح بواسطة» dropdown listing every editor
 *   that claims the open file's extension, persisting the choice per extension
 *   (`loam.editor.override.<ext>` = kind in localStorage).
 * - `EditorFallbackCard`: the honest card shown when no editor claims a file —
 *   the file's basic info and a download (the `/api/media` raw-file endpoint),
 *   never a fake edit button.
 */

import { useState } from 'react';
import { Check, ChevronDown, Download, FileQuestion } from 'lucide-react';
import { getLocale as getI18nLocale, isRtl, t } from '@/i18n/t';
import { CRAFT_APPS, type CraftApp } from '@/lib/craftBridge';
import { craftAppForExtension, craftAppForMime, craftExtOf } from './craft';
import {
  getEditorOverride,
  listEditorsForPath,
  setEditorOverride,
} from './registry';
import type { WorkspaceEditorDef, WorkspaceFile, WorkspaceKind } from './types';

/** The Loam display name for a file the Craft apps own, else the editor's own label. */
export function editorLabel(def: WorkspaceEditorDef | null, file: WorkspaceFile | null): string {
  if (!def) return '';
  if (def.kind === 'craft') {
    const app = file ? craftAppForFile(file) : null;
    if (app) return CRAFT_APPS[app].displayName;
    return t('Loam Craft');
  }
  return def.label;
}

/** The Craft app (docs/sheets/slides/photo/design) that owns this file, if any. */
function craftAppForFile(file: WorkspaceFile): CraftApp | null {
  const fromExt = craftAppForExtension(craftExtOf(file.path));
  if (fromExt) return fromExt;
  return craftAppForMime(file.mime ?? '');
}

/** The minimum a gateway card needs to know about a file; WorkspaceFile satisfies it. */
export interface GatewayFile {
  taskId: string;
  path: string;
  name: string;
  mime?: string;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * The honest card for a file type no editor claims: the file's basic info and a
 * download button (the task workspace raw-file endpoint), with no pretend edit
 * affordance. The text follows the app locale (Arabic renders RTL).
 */
export function EditorFallbackCard({
  file,
  size,
  apiBase = '',
}: {
  file: GatewayFile;
  /** Known file size in bytes, when the listing provided one. */
  size?: number;
  apiBase?: string;
}) {
  const ext = craftExtOf(file.path);
  const downloadUrl =
    file.taskId && file.path
      ? `${apiBase}/api/media?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`
      : null;
  const sizeLabel = typeof size === 'number' ? formatBytes(size) : '';
  return (
    <div
      dir={isRtl(getI18nLocale()) ? 'rtl' : 'ltr'}
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <FileQuestion aria-hidden="true" className="size-8 text-text-quaternary" />
      <p className="text-sm font-medium text-text-secondary">{t('No editor for this file type yet.')}</p>
      <p className="max-w-sm text-xs leading-5 text-text-tertiary">
        {t('Loam can open many file types; this one can only be downloaded for now.')}
      </p>
      <div className="rounded-control border border-border-main bg-bg-menu px-4 py-3 text-xs text-text-tertiary">
        <p className="font-medium text-text-secondary">{file.name}</p>
        <p>
          {t('Type: {type}', { type: ext ? ext.toUpperCase() : t('Unknown') })}
          {sizeLabel ? ` · ${sizeLabel}` : ''}
        </p>
      </div>
      {downloadUrl && (
        <a
          href={downloadUrl}
          download={file.name}
          className="flex items-center gap-1.5 rounded-control bg-fill-tsp px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-fill-hover"
        >
          <Download aria-hidden="true" className="size-3.5" />
          {t('Download file')}
        </a>
      )}
    </div>
  );
}

/**
 * The «فتح بواسطة» editor override dropdown: every registered editor claiming the
 * file's extension plus the automatic pick, persisted per extension in localStorage.
 */
export function EditorOverrideMenu({ file }: { file: WorkspaceFile }) {
  const [open, setOpen] = useState(false);
  const ext = craftExtOf(file.path);
  // Computed per render on purpose: editor registrations land asynchronously and
  // the override menu must reflect what is registered right now.
  const candidates = listEditorsForPath(file.path);
  const active = getEditorOverride(ext);
  if (candidates.length === 0) return null;

  const choose = (kind: WorkspaceKind | null): void => {
    setEditorOverride(ext, kind);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 whitespace-nowrap rounded-control px-2 py-1 text-xs text-text-tertiary hover:bg-fill-hover hover:text-text-secondary"
      >
        {t('Open with')}
        <ChevronDown aria-hidden="true" className="size-3" />
      </button>
      {open && (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute end-0 top-full z-50 mt-1 min-w-44 rounded-control border border-border-main bg-bg-menu py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!active}
              onClick={() => choose(null)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-fill-hover"
            >
              <Check aria-hidden="true" className={`size-3 ${active ? 'invisible' : ''}`} />
              {t('Automatic')}
            </button>
            {candidates.map((def) => (
              <button
                key={def.kind}
                type="button"
                role="menuitemradio"
                aria-checked={active === def.kind}
                onClick={() => choose(def.kind)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-fill-hover"
              >
                <Check aria-hidden="true" className={`size-3 ${active === def.kind ? '' : 'invisible'}`} />
                {editorLabel(def, file)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
